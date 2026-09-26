import cacheManager from '@server/lib/cache';
import axios, { type AxiosAdapter } from 'axios';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import ReadarrAPI, { type ReadarrBookOptions } from './readarr';

class RecordingReadarrAPI extends ReadarrAPI {
  constructor(baseUrl: string, adapter: AxiosAdapter) {
    super({ url: baseUrl, apiKey: 'test-key' });
    this.axios.defaults.adapter = adapter;
  }

  async cacheAuthor() {
    await this.get('/author/7');
  }
}

const options: ReadarrBookOptions = {
  title: 'Requested Book',
  hcId: 101,
  authorHcId: 102,
  qualityProfileId: 1,
  metadataProfileId: 1,
  profileId: 1,
  tags: [],
  rootFolderPath: '/books',
  searchNow: true,
};

function fixture(scope = '') {
  const baseUrl = `http://readarr.test${scope}/api/v1`;
  const requests: { method: string; path: string; body: unknown }[] = [];
  const book = {
    id: 22,
    authorId: 7,
    monitored: true,
    grabbed: false,
    foreignBookId: '101',
    foreignEditionId: '103',
    author: {},
    anyEditionOk: false,
  };
  const author = {
    id: 7,
    monitored: false,
    path: '/books/Example Author',
    qualityProfileId: 1,
    metadataProfileId: 1,
    tags: [3],
    monitorNewItems: 'none',
    syncMonitoredAcrossFormats: true,
  };
  const editions = [
    { foreignEditionId: '103', monitored: true },
    { foreignEditionId: '104', monitored: false },
  ];
  let authorFailure: string | undefined;
  const api = new RecordingReadarrAPI(baseUrl, async (config) => {
    const method = config.method;
    const path = config.url;
    const body = config.data ? JSON.parse(config.data) : undefined;
    requests.push({
      method: method ?? '',
      path: new URL(axios.getUri(config)).pathname,
      body,
    });

    if (path === '/author/7' && method === authorFailure) {
      throw new Error('Author request failed');
    }

    let data: unknown;
    if (method === 'get' && path === '/book/lookup') {
      data = [{ ...book }];
    } else if (method === 'get' && path === '/author/7') {
      data = { ...author };
    } else if (method === 'get' && path === '/book/22') {
      data = { ...book };
    } else if (method === 'get' && path === '/edition') {
      data = editions.map((edition) => ({ ...edition }));
    } else if (method === 'post' && path === '/book') {
      data = { ...body, id: 22, authorId: 7 };
    } else if (
      (method === 'put' && ['/author/7', '/book'].includes(path ?? '')) ||
      (method === 'post' && path === '/command')
    ) {
      data = body;
    } else {
      throw new Error(`Unexpected request: ${method} ${path}`);
    }

    return { data, status: 200, statusText: 'OK', headers: {}, config };
  });

  return {
    api,
    book,
    author,
    editions,
    requests,
    failAuthor(method: string) {
      authorFailure = method;
    },
  };
}

describe('Readarr author monitoring for book requests', () => {
  beforeEach(() => cacheManager.getCache('readarr').flush());

  it('updates an existing unmonitored book and resumes its author before searching', async () => {
    const { api, book, author, requests } = fixture();
    book.monitored = false;

    await api.addBook(options);
    await setImmediate();

    const authorPutIndex = requests.findIndex(
      (request) =>
        request.method === 'put' && request.path.endsWith('/author/7')
    );
    assert.deepEqual(requests[authorPutIndex], {
      method: 'put',
      path: '/api/v1/author/7',
      body: { ...author, monitored: true },
    });
    const bookPutIndex = requests.findIndex(
      (request) => request.method === 'put' && request.path.endsWith('/book')
    );
    assert.ok(bookPutIndex !== -1 && bookPutIndex < authorPutIndex);
    assert.ok(
      authorPutIndex <
        requests.findIndex((request) => request.path.endsWith('/command'))
    );
  });

  it('reasserts scoped book monitoring while preserving current settings and editions despite a different lookup selection', async () => {
    const { api, book, editions, requests } = fixture('/audiobook');
    await api.getBook(book.id);
    await api.getEditions(book.id);
    book.anyEditionOk = true;
    editions[0].monitored = false;
    editions[1].monitored = true;
    requests.length = 0;

    await api.addBook(options);
    await setImmediate();

    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      [
        'get /audiobook/api/v1/book/lookup',
        'get /audiobook/api/v1/book/22',
        'get /audiobook/api/v1/edition',
        'put /audiobook/api/v1/book',
        'get /audiobook/api/v1/author/7',
        'put /audiobook/api/v1/author/7',
        'post /audiobook/api/v1/command',
      ]
    );
    const bookPut = requests.find(
      (request) => request.method === 'put' && request.path.endsWith('/book')
    )?.body as {
      monitored: boolean;
      anyEditionOk: boolean;
      editions: typeof editions;
    };
    assert.equal(bookPut.monitored, true);
    assert.equal(bookPut.anyEditionOk, true);
    assert.deepEqual(bookPut.editions, editions);
  });

  it('checks the author after adding a new book', async () => {
    const { api, book, requests } = fixture();
    book.id = 0;

    await api.addBook(options);
    await setImmediate();

    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      [
        'get /api/v1/book/lookup',
        'post /api/v1/book',
        'get /api/v1/author/7',
        'put /api/v1/author/7',
        'post /api/v1/command',
      ]
    );
  });

  it('does not rewrite an already monitored author', async () => {
    const { api, author, requests } = fixture();
    author.monitored = true;

    await api.addBook({ ...options, searchNow: false });

    assert.ok(
      !requests.some(
        (request) =>
          request.method === 'put' && request.path.endsWith('/author/7')
      )
    );
    assert.ok(
      requests.some(
        (request) => request.method === 'put' && request.path.endsWith('/book')
      )
    );
    assert.ok(!requests.some((request) => request.path.endsWith('/command')));
  });

  it('uses fresh author state even when the cached author is monitored', async () => {
    const { api, author, requests } = fixture();
    author.monitored = true;
    await api.cacheAuthor();
    author.monitored = false;
    requests.length = 0;

    await api.addBook({ ...options, searchNow: false });

    assert.deepEqual(
      requests.map(({ method, path }) => `${method} ${path}`),
      [
        'get /api/v1/book/lookup',
        'get /api/v1/book/22',
        'get /api/v1/edition',
        'put /api/v1/book',
        'get /api/v1/author/7',
        'put /api/v1/author/7',
      ]
    );
  });

  it('fails without searching when the author update fails', async () => {
    const { api, failAuthor, requests } = fixture();
    failAuthor('put');

    await assert.rejects(api.addBook(options), {
      message: 'Failed to add book to Readarr',
    });
    assert.ok(!requests.some((request) => request.path.endsWith('/command')));
  });
});
