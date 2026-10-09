import type { ReadarrBook } from '@server/api/servarr/readarr';
import ReadarrAPI from '@server/api/servarr/readarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { ReadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: ReadarrSettings;
  servers: ReadarrSettings[];
};

class ReadarrScanner
  extends BaseScanner<ReadarrBook>
  implements RunnableScanner<SyncStatus>
{
  private servers: ReadarrSettings[];
  private currentServer: ReadarrSettings;
  private readarrApi: ReadarrAPI;
  private scannedHcIds: Set<number> = new Set();
  private scannedAudioHcIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScanAudio = false;
  private serverReturnedEmpty = false;
  private serverAudioReturnedEmpty = false;
  private isRecentOnly = false;

  constructor(isRecentOnly = false) {
    super('Readarr Scan', { bundleSize: 50 });
    this.isRecentOnly = isRecentOnly;
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    if (this.running) {
      this.log('Scan already in progress. Skipping.', 'info');
      return;
    }

    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedHcIds.clear();
    this.scannedAudioHcIds.clear();
    this.didScanStandard = false;
    this.didScanAudio = false;
    this.serverReturnedEmpty = false;
    this.serverAudioReturnedEmpty = false;

    try {
      this.servers = uniqWith(settings.readarr, (readarrA, readarrB) => {
        return (
          readarrA.hostname === readarrB.hostname &&
          readarrA.port === readarrB.port &&
          readarrA.baseUrl === readarrB.baseUrl
        );
      });

      for (const server of this.servers) {
        this.currentServer = server;
        if (server.syncEnabled) {
          if (this.isRecentOnly) {
            await this.runRecentScan(server, sessionId);
          } else {
            await this.runFullScan(server, sessionId);
          }
        } else {
          this.log(`Sync not enabled. Skipping Readarr server: ${server.name}`);
        }
      }

      // Only run orphan cleanup during full scans
      if (!this.isRecentOnly) {
        // Only run cleanup if all servers of this profile type have sync enabled.
        // If any server is skipped, we can't distinguish truly orphaned media from
        // media that exists on an unscanned server (e.g. separate instances for
        // different genres or languages).
        const allStandardScanned = this.servers
          .filter((s) => !this.enableAudioBook || !s.is4k)
          .every((s) => s.syncEnabled);
        const allAudioScanned = this.servers
          .filter((s) => this.enableAudioBook && s.is4k)
          .every((s) => s.syncEnabled);

        if (!allStandardScanned) {
          this.didScanStandard = false;
        }
        if (!allAudioScanned) {
          this.didScanAudio = false;
        }
        if (this.serverReturnedEmpty) {
          this.didScanStandard = false;
        }
        if (this.serverAudioReturnedEmpty) {
          this.didScanAudio = false;
        }

        await this.cleanupOrphanedBooks();
      }

      this.log(
        this.isRecentOnly
          ? 'Recently Added Scan Complete'
          : 'Full Scan Complete',
        'info'
      );
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async runFullScan(
    server: ReadarrSettings,
    sessionId: string
  ): Promise<void> {
    this.log(`Beginning to process Readarr server: ${server.name}`, 'info');

    this.readarrApi = new ReadarrAPI({
      apiKey: server.apiKey,
      url: ReadarrAPI.buildUrl(server, '/api/v1'),
    });

    this.items = await this.readarrApi.getBooks();

    const serverAudio = this.enableAudioBook && server.is4k;
    if (serverAudio) {
      this.didScanAudio = true;
    } else {
      this.didScanStandard = true;
    }

    if (this.items.length === 0) {
      if (serverAudio) {
        this.serverAudioReturnedEmpty = true;
      } else {
        this.serverReturnedEmpty = true;
      }
      this.log(
        `Readarr server ${server.name} returned no books. Orphan cleanup for this profile type will be skipped.`,
        'warn'
      );
    }

    await this.loop(this.processReadarrBook.bind(this), { sessionId });
  }

  private async runRecentScan(
    server: ReadarrSettings,
    sessionId: string
  ): Promise<void> {
    this.log(
      `Beginning to process recently added for Readarr server: ${server.name}`,
      'info'
    );

    this.readarrApi = new ReadarrAPI({
      apiKey: server.apiKey,
      url: ReadarrAPI.buildUrl(server, '/api/v1'),
    });

    const allBooks = await this.readarrApi.getBooks();

    // Compare Readarr's state against what Seerr already has in its database.
    // We skip any book that:
    // 1. Has no valid Hardcover ID (can't be processed)
    // 2. Is not already in Seerr (discovery is the full scan's job)
    // 3. Already exists in Seerr with the same status (nothing to update)
    const mediaRepository = getRepository(Media);
    const existingMedia = await mediaRepository.find({
      where: { mediaType: MediaType.BOOK },
      select: ['tmdbId', 'status', 'status4k'],
    });
    const existingMediaMap = new Map(existingMedia.map((m) => [m.tmdbId, m]));

    const serverAudio = this.enableAudioBook && server.is4k;

    this.items = allBooks.filter((book) => {
      const hcId = parseInt(book.foreignBookId, 10);
      if (isNaN(hcId)) return false;

      const existing = existingMediaMap.get(hcId);
      const hasFile = (book.statistics?.bookFileCount ?? 0) > 0;

      if (!existing) {
        // Book not in Seerr — skip it. Discovery of new books is the
        // full scan's responsibility.
        return false;
      }

      // Check if the status in Seerr matches what Readarr reports
      const currentStatus = serverAudio ? existing.status4k : existing.status;

      if (hasFile && currentStatus === MediaStatus.AVAILABLE) {
        return false;
      }

      if (
        !hasFile &&
        (book.monitored || book.grabbed) &&
        currentStatus === MediaStatus.PROCESSING
      ) {
        return false;
      }

      // Status mismatch — needs updating
      return true;
    });

    this.log(
      `Filtered ${allBooks.length} total books to ${this.items.length} with state changes`,
      'info'
    );

    if (this.items.length === 0) {
      this.log(
        `No recently added books found for server: ${server.name}`,
        'info'
      );
    } else {
      await this.loop(this.processReadarrBook.bind(this), { sessionId });
    }
  }

  private async processReadarrBook(readarrBook: ReadarrBook): Promise<void> {
    const serverAudio = this.enableAudioBook && this.currentServer.is4k;
    const hcId = parseInt(readarrBook.foreignBookId, 10);

    if (isNaN(hcId)) {
      this.log('Invalid Hardcover ID for book. Skipping item.', 'debug', {
        title: readarrBook.title,
        foreignBookId: readarrBook.foreignBookId,
      });
      return;
    }

    if (serverAudio) {
      this.scannedAudioHcIds.add(hcId);
    } else {
      this.scannedHcIds.add(hcId);
    }

    try {
      // Use bookFileCount as indicator of having files. In original Readarr,
      // percentOfBooks (bookFileCount / bookCount * 100) works because
      // bookCount includes books with files regardless of monitoring state.
      // Some forks removed that fallback, with bookCount tied to monitoring
      // state, so unmonitored books with files report percentOfBooks=0.
      // bookFileCount > 0 inherently implies percentOfBooks >= 100 and works
      // correctly for both implementations.
      const hasFile = (readarrBook.statistics?.bookFileCount ?? 0) > 0;

      await this.processBook(hcId, {
        is4k: serverAudio,
        serviceId: this.currentServer.id,
        externalServiceId: readarrBook.id,
        externalServiceSlug: readarrBook.titleSlug,
        title: readarrBook.title,
        processing: !hasFile && (readarrBook.monitored || readarrBook.grabbed),
        hasFile,
      });
    } catch (e) {
      this.log('Failed to process Readarr media', 'error', {
        errorMessage: e.message,
        title: readarrBook.title,
      });
    }
  }

  private async existsInAnyServer(
    hcId: number,
    isAudio: boolean
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.syncEnabled && (this.enableAudioBook && server.is4k) === isAudio
    );

    for (const server of servers) {
      try {
        const api = new ReadarrAPI({
          apiKey: server.apiKey,
          url: ReadarrAPI.buildUrl(server, '/api/v1'),
        });
        const book = await api.getBookByHcId(hcId);

        if (book.id) {
          return true;
        }
      } catch (e) {
        this.log(
          `Could not confirm book ${hcId} against Readarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          { errorMessage: e.message }
        );
        return true;
      }
    }

    return false;
  }

  private async cleanupOrphanedBooks(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingBooks = await mediaRepository.find({
        where: { mediaType: MediaType.BOOK, status: MediaStatus.PROCESSING },
        relations: { requests: true },
      });

      for (const media of processingBooks) {
        if (!this.scannedHcIds.has(media.tmdbId)) {
          if (await this.existsInAnyServer(media.tmdbId, false)) {
            continue;
          }

          media.status = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, false);
          this.log(
            `Book ${media.tmdbId} not found in any Readarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned book cleanup: no standard Readarr servers were scanned.',
        'info'
      );
    }

    if (this.didScanAudio) {
      const processingAudioBooks = await mediaRepository.find({
        where: {
          mediaType: MediaType.BOOK,
          status4k: MediaStatus.PROCESSING,
        },
        relations: { requests: true },
      });

      for (const media of processingAudioBooks) {
        if (!this.scannedAudioHcIds.has(media.tmdbId)) {
          if (await this.existsInAnyServer(media.tmdbId, true)) {
            continue;
          }

          media.status4k = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, true);
          this.log(
            `Book ${media.tmdbId} not found in any audiobook Readarr server. Audiobook status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enableAudioBook) {
      this.log(
        'Skipping orphaned audiobook cleanup: no audiobook Readarr servers were scanned.',
        'info'
      );
    }
  }
}

export const readarrScanner = new ReadarrScanner();
export const readarrRecentScanner = new ReadarrScanner(true);
