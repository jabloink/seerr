import HardcoverLogo from '@app/assets/hardcover.svg';
import AuthorCard from '@app/components/AuthorCard';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tag from '@app/components/Common/Tag';
import Tooltip from '@app/components/Common/Tooltip';
import IssueModal from '@app/components/IssueModal';
import ManageSlideOver from '@app/components/ManageSlideOver';
import RequestButton from '@app/components/RequestButton';
import Slider from '@app/components/Slider';
import StatusBadge from '@app/components/StatusBadge';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { refreshIntervalHelper } from '@app/utils/refreshIntervalHelper';
import {
  CogIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { IssueStatus } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import type { BookDetails as BookDetailsType } from '@server/models/Book';
import axios from 'axios';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.BookDetails', {
  overview: 'Overview',
  author: 'Author',
  overviewunavailable: 'Overview unavailable.',
  openreadarr: 'Open Book in Readarr',
  openreadarrAudio: 'Open Audiobook in Readarr',
  downloadstatus: 'Download Status',
  markavailable: 'Mark as Available',
  markAudioavailable: 'Mark Audiobook as Available',
  reportissue: 'Report an Issue',
  managebook: 'Manage Book',
  releasedate: 'Release Date',
  publisher: 'Publisher',
  language: 'Language',
  isbn: 'ISBN',
  format: 'Format',
  audiobookduration: 'Audiobook Duration',
  narrators: 'Narrator{narratorCount, plural, one {} other {s}}',
});

interface BookDetailsProps {
  book?: BookDetailsType;
}

const BookDetails = ({ book }: BookDetailsProps) => {
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const router = useRouter();
  const intl = useIntl();
  const [showManager, setShowManager] = useState(false);
  const [showIssueModal, setShowIssueModal] = useState(false);
  const [isBlocklistUpdating, setIsBlocklistUpdating] =
    useState<boolean>(false);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const { addToast } = useToasts();

  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<BookDetailsType>(`/api/v1/book/${router.query.bookId}`, {
    fallbackData: book,
    refreshInterval: refreshIntervalHelper(
      {
        downloadStatus: book?.mediaInfo?.downloadStatus,
        downloadStatus4k: book?.mediaInfo?.downloadStatus4k,
      },
      15000
    ),
  });

  useEffect(() => {
    if (router.query.manage === '1') {
      setShowManager(true);
      router.replace({
        pathname: router.pathname,
        query: { bookId: router.query.bookId },
      });
    }
  }, [router, router.query.manage]);

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const { mediaUrl: plexUrl, mediaUrl4k: plexUrl4k } = useDeepLinks({
    mediaUrl: data?.mediaInfo?.mediaUrl,
    mediaUrl4k: data?.mediaInfo?.mediaUrl4k,
    iOSPlexUrl: data?.mediaInfo?.iOSPlexUrl,
    iOSPlexUrl4k: data?.mediaInfo?.iOSPlexUrl4k,
  });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <ErrorPage statusCode={404} />;
  }

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsBlocklistUpdating(true);

    try {
      await axios.post('/api/v1/blocklist', {
        tmdbId: book?.id,
        mediaType: 'book',
        title: book?.title,
        user: user?.id,
      });

      addToast(
        <span>
          {intl.formatMessage(globalMessages.blocklistSuccess, {
            title: book?.title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );

      revalidate();
    } catch (e) {
      if (e?.response?.status === 412) {
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistDuplicateError, {
              title: book?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    }

    setIsBlocklistUpdating(false);
    closeBlocklistModal();
  };

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

  return (
    <div
      className="media-page"
      style={{
        height: 493,
      }}
    >
      <div className="media-page-bg-image">
        <CachedImage
          type="hardcover"
          alt=""
          src={data.backdropPath}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          fill
          priority
        />
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(180deg, rgba(17, 24, 39, 0.47) 0%, rgba(17, 24, 39, 1) 100%)',
          }}
        />
      </div>
      <PageTitle title={data.title} />
      <IssueModal
        onCancel={() => setShowIssueModal(false)}
        show={showIssueModal}
        mediaType={MediaType.BOOK}
        tmdbId={data.id}
      />
      <ManageSlideOver
        data={data}
        mediaType={MediaType.BOOK}
        onClose={() => {
          setShowManager(false);
          router.replace({
            pathname: router.pathname,
            query: { bookId: router.query.bookId },
          });
        }}
        revalidate={() => revalidate()}
        show={showManager}
      />
      <BlocklistModal
        tmdbId={data.id}
        type="book"
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isBlocklistUpdating}
      />
      <div className="media-header">
        <div className="media-poster">
          <CachedImage
            type="hardcover"
            src={data.posterPath}
            alt=""
            sizes="100vw"
            style={{ width: '100%', height: 'auto' }}
            width={600}
            height={900}
            priority
          />
        </div>
        <div className="media-title">
          <div className="media-status">
            <StatusBadge
              status={data.mediaInfo?.status}
              downloadItem={data.mediaInfo?.downloadStatus}
              title={data.title}
              inProgress={(data.mediaInfo?.downloadStatus ?? []).length > 0}
              tmdbId={data.mediaInfo?.tmdbId}
              mediaType={MediaType.BOOK}
              plexUrl={plexUrl}
              serviceUrl={data.mediaInfo?.serviceUrl}
            />
            {settings.currentSettings.bookAudioEnabled &&
              hasPermission(
                [
                  Permission.MANAGE_REQUESTS,
                  Permission.REQUEST_4K,
                  Permission.REQUEST_AUDIO_BOOK,
                ],
                {
                  type: 'or',
                }
              ) && (
                <StatusBadge
                  status={data.mediaInfo?.status4k}
                  downloadItem={data.mediaInfo?.downloadStatus4k}
                  title={data.title}
                  is4k
                  inProgress={
                    (data.mediaInfo?.downloadStatus4k ?? []).length > 0
                  }
                  tmdbId={data.mediaInfo?.tmdbId}
                  mediaType={MediaType.BOOK}
                  plexUrl={plexUrl4k}
                  serviceUrl={data.mediaInfo?.serviceUrl4k}
                />
              )}
          </div>
          <h1 data-testid="media-title">
            {data.title}{' '}
            {data.releaseDate && (
              <span className="media-year">
                ({data.releaseDate.slice(0, 4)})
              </span>
            )}
          </h1>
          <span className="media-attributes">
            {data.pages && <span>{`${data.pages} pages`}</span>}
          </span>
        </div>
        <div className="media-actions">
          {showHideButton &&
            data?.mediaInfo?.status !== MediaStatus.PROCESSING &&
            data?.mediaInfo?.status !== MediaStatus.AVAILABLE &&
            data?.mediaInfo?.status !== MediaStatus.PARTIALLY_AVAILABLE &&
            data?.mediaInfo?.status !== MediaStatus.PENDING &&
            data?.mediaInfo?.status !== MediaStatus.BLOCKLISTED && (
              <Tooltip
                content={intl.formatMessage(globalMessages.addToBlocklist)}
              >
                <Button
                  buttonType={'ghost'}
                  className="z-40 mr-2"
                  buttonSize={'md'}
                  onClick={() => setShowBlocklistModal(true)}
                >
                  <EyeSlashIcon />
                </Button>
              </Tooltip>
            )}
          <RequestButton
            mediaType={MediaType.BOOK}
            media={data.mediaInfo}
            tmdbId={data.id}
            onUpdate={() => revalidate()}
          />
          {(data.mediaInfo?.status === MediaStatus.AVAILABLE ||
            (settings.currentSettings.bookAudioEnabled &&
              hasPermission(
                [Permission.REQUEST_4K, Permission.REQUEST_AUDIO_BOOK],
                {
                  type: 'or',
                }
              ) &&
              data.mediaInfo?.status4k === MediaStatus.AVAILABLE)) &&
            hasPermission(
              [Permission.CREATE_ISSUES, Permission.MANAGE_ISSUES],
              {
                type: 'or',
              }
            ) && (
              <Tooltip content={intl.formatMessage(messages.reportissue)}>
                <Button
                  buttonType="warning"
                  onClick={() => setShowIssueModal(true)}
                  className="ml-2 first:ml-0"
                >
                  <ExclamationTriangleIcon />
                </Button>
              </Tooltip>
            )}
          {hasPermission(Permission.MANAGE_REQUESTS) &&
            data.mediaInfo &&
            (data.mediaInfo.jellyfinMediaId ||
              data.mediaInfo.jellyfinMediaId4k ||
              data.mediaInfo.status !== MediaStatus.UNKNOWN ||
              data.mediaInfo.status4k !== MediaStatus.UNKNOWN) && (
              <Tooltip content={intl.formatMessage(messages.managebook)}>
                <Button
                  buttonType="ghost"
                  onClick={() => setShowManager(true)}
                  className="relative ml-2 first:ml-0"
                >
                  <CogIcon className="!mr-0" />
                  {hasPermission(
                    [Permission.MANAGE_ISSUES, Permission.VIEW_ISSUES],
                    {
                      type: 'or',
                    }
                  ) &&
                    (
                      data.mediaInfo?.issues.filter(
                        (issue) => issue.status === IssueStatus.OPEN
                      ) ?? []
                    ).length > 0 && (
                      <>
                        <div className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-red-600" />
                        <div className="absolute -right-1 -top-1 h-3 w-3 animate-ping rounded-full bg-red-600" />
                      </>
                    )}
                </Button>
              </Tooltip>
            )}
        </div>
      </div>
      <div className="media-overview">
        <div className="media-overview-left">
          {data.headline && <div className="tagline">{data.headline}</div>}
          <h2>{intl.formatMessage(messages.overview)}</h2>
          <p>
            {data.description
              ? data.description
              : intl.formatMessage(messages.overviewunavailable)}
          </p>
          <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {data.tags.Genre?.length > 0 && (
              <div>
                <h2>Genres</h2>
                <div className="pt-4">
                  {data.tags.Genre.map((genre) => (
                    <span
                      key={`genre-${genre.tagSlug}`}
                      className="mb-2 mr-2 inline-flex last:mr-0"
                    >
                      <Tag>{genre.tag}</Tag>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {data.tags.Mood?.length > 0 && (
              <div>
                <h2>Moods</h2>
                <div className="pt-4">
                  {data.tags.Mood.map((mood) => (
                    <span
                      key={`mood-${mood.tagSlug}`}
                      className="mb-2 mr-2 inline-flex last:mr-0"
                    >
                      <Tag>{mood.tag}</Tag>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {data.tags['Content Warning']?.length > 0 && (
              <div>
                <h2>Content Warning</h2>
                <div className="pt-4">
                  {data.tags['Content Warning'].map((warn) => (
                    <span
                      key={`warning-${warn.tagSlug}`}
                      className="mb-2 mr-2 inline-flex last:mr-0"
                    >
                      <Tag>{warn.tag}</Tag>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="media-overview-right">
          {data.series.length > 0 &&
            data.series.map((series) => (
              <div className="mb-6" key={`series-${series.series_id}`}>
                <Link href={`/series/${series.series_id}`}>
                  <div className="group relative z-0 scale-100 transform-gpu cursor-pointer overflow-hidden rounded-lg bg-gray-800 bg-cover bg-center shadow-md ring-1 ring-gray-700 transition duration-300 hover:scale-105 hover:ring-gray-500">
                    <div className="absolute inset-0 z-0">
                      <CachedImage
                        type="hardcover"
                        src={`https://assets.hardcover.app/static/covers/cover${
                          (series.series_id % 9) + 1
                        }.png`}
                        alt=""
                        style={{ objectFit: 'cover' }}
                        fill
                      />
                      <div
                        className="absolute inset-0"
                        style={{
                          backgroundImage:
                            'linear-gradient(180deg, rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 0.80) 100%)',
                        }}
                      />
                    </div>
                    <div className="relative z-10 flex h-full items-center justify-between p-4 text-gray-200 transition duration-300 group-hover:text-white">
                      <div className="flex flex-col">
                        <div className="font-medium">{series.series.name}</div>
                        {series.position && (
                          <div className="text-sm text-gray-300">
                            Book {series.position} of{' '}
                            {series.series.primary_books_count}
                          </div>
                        )}
                      </div>
                      <Button buttonSize="sm">
                        {intl.formatMessage(globalMessages.view)}
                      </Button>
                    </div>
                  </div>
                </Link>
              </div>
            ))}
          <div className="media-facts">
            {data.rating != null && (
              <div className="media-ratings">
                {data.slug ? (
                  <a
                    href={`https://hardcover.app/books/${encodeURIComponent(
                      data.slug
                    )}`}
                    className="media-rating"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <HardcoverLogo className="w-6" />
                    <span>{data.rating.toFixed(1)}</span>
                  </a>
                ) : (
                  <span className="media-rating">
                    <HardcoverLogo className="w-6" />
                    <span>{data.rating.toFixed(1)}</span>
                  </span>
                )}
              </div>
            )}
            {data.releaseDate && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.releasedate)}</span>
                <span className="media-fact-value">
                  {intl.formatDate(data.releaseDate, {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    timeZone: 'UTC',
                  })}
                </span>
              </div>
            )}
            {data.publisher && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.publisher)}</span>
                <span className="media-fact-value">{data.publisher}</span>
              </div>
            )}
            {data.language && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.language)}</span>
                <span className="media-fact-value">{data.language}</span>
              </div>
            )}
            {data.isbn && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.isbn)}</span>
                <span className="media-fact-value">{data.isbn}</span>
              </div>
            )}
            {data.format && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.format)}</span>
                <span className="media-fact-value">{data.format}</span>
              </div>
            )}
            {data.audiobookDuration && data.audiobookDuration > 0 && (
              <div className="media-fact">
                <span>{intl.formatMessage(messages.audiobookduration)}</span>
                <span className="media-fact-value">
                  {Math.floor(data.audiobookDuration / 3600)}h{' '}
                  {Math.floor((data.audiobookDuration % 3600) / 60)}m
                </span>
              </div>
            )}
            {data.narrators && data.narrators.length > 0 && (
              <div className="media-fact">
                <span>
                  {intl.formatMessage(messages.narrators, {
                    narratorCount: data.narrators.length,
                  })}
                </span>
                <span className="media-fact-value">
                  {data.narrators.join(', ')}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      {data.author.length > 0 && (
        <>
          <div className="slider-header">
            <div className="slider-title">
              <span>{intl.formatMessage(messages.author)}</span>
            </div>
          </div>
          <Slider
            sliderKey="author"
            isLoading={false}
            isEmpty={false}
            items={data.author.slice(0, 20).map((author) => (
              <AuthorCard
                key={`author-${author.id}`}
                authorId={author.id}
                name={author.name}
                image={author.image?.url}
              />
            ))}
          />
        </>
      )}
      <div className="extra-bottom-space relative" />
    </div>
  );
};

export default BookDetails;
