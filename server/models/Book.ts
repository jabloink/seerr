import { getHeader } from '@server/api/hardcover';
import type {
  Author,
  HardcoverBookDetails,
  HardcoverSeries,
  Tags,
} from '@server/api/hardcover/interfaces';
import type Media from '@server/entity/Media';
import type { ExternalIds } from './common';

export interface BookDetails {
  id: number;
  title: string;
  description: string;
  releaseDate: string;
  image?: {
    url: string;
  };
  mediaInfo?: Media;
  externalIds?: ExternalIds;
  author: Author[];
  pages: number;
  tags: Tags;
  headline: string;
  subtitle: string;
  series: {
    position: number;
    series_id: number;
    series: HardcoverSeries;
  }[];
  posterPath: string;
  backdropPath: string;
  slug: string;
  rating?: number;
  ratingsCount?: number;
  reviewsCount?: number;
  publisher?: string;
  language?: string;
  isbn?: string;
  format?: string;
  hasPhysicalEdition: boolean;
  hasEbookEdition: boolean;
  hasAudioEdition: boolean;
  audiobookDuration?: number;
  narrators?: string[];
}

export const mapBookDetails = (
  book: HardcoverBookDetails,
  media?: Media
): BookDetails => ({
  id: book.id,
  title: book.title,
  description: book.description,
  releaseDate: book.release_date,
  tags: book.cached_tags,
  headline: book.headline,
  subtitle: book.subtitle,
  pages: book.pages,
  mediaInfo: media,
  author: book.contributions.map((e) => e.author),
  series: book.book_series,
  posterPath: book.image?.url
    ? book.image.url
    : `https://assets.hardcover.app/static/covers/cover${
        (book.id % 9) + 1
      }.png`,
  backdropPath: (() => {
    const header = getHeader(book.cached_tags);
    if (header) {
      return `https://assets.hardcover.app/static/bookHeaders/${header}.webp`;
    }
    return '';
  })(),
  slug: book.slug,
  rating: book.rating,
  ratingsCount: book.ratings_count ?? 0,
  reviewsCount: book.reviews_count ?? 0,
  publisher: book.default_physical_edition?.publisher?.name,
  language: book.default_physical_edition?.language?.language,
  isbn:
    book.default_physical_edition?.isbn_13 ??
    book.default_physical_edition?.isbn_10 ??
    book.default_ebook_edition?.isbn_13,
  format: book.default_physical_edition?.physical_format,
  hasPhysicalEdition: !!book.default_physical_edition_id,
  hasEbookEdition: !!book.default_ebook_edition_id,
  hasAudioEdition: !!book.default_audio_edition_id,
  audiobookDuration: book.default_audio_edition?.audio_seconds,
  narrators: book.default_audio_edition?.contributions
    ?.map((c) => c.author?.name)
    .filter(Boolean) as string[] | undefined,
});
