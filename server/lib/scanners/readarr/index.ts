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

  constructor() {
    super('Readarr Scan', { bundleSize: 50 });
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
          this.log(
            `Beginning to process Readarr server: ${server.name}`,
            'info'
          );

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
        } else {
          this.log(`Sync not enabled. Skipping Readarr server: ${server.name}`);
        }
      }

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
      this.log('Readarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      this.endRun(sessionId);
    }
  }

  private async processReadarrBook(readarrBook: ReadarrBook): Promise<void> {
    const serverAudio = this.enableAudioBook && this.currentServer.is4k;
    const hcId = parseInt(readarrBook.foreignBookId, 10);

    if (isNaN(hcId)) {
      this.log('Invalid Hardcover ID for book. Skipping item.', 'warn', {
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
      const isFullyDownloaded = readarrBook.statistics?.percentOfBooks >= 100;

      await this.processBook(hcId, {
        is4k: serverAudio,
        serviceId: this.currentServer.id,
        externalServiceId: readarrBook.id,
        externalServiceSlug: readarrBook.titleSlug,
        title: readarrBook.title,
        processing:
          !isFullyDownloaded && (readarrBook.monitored || readarrBook.grabbed),
        hasFile: isFullyDownloaded,
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
