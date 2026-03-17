import Hardcover from '@server/api/hardcover';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapSeries } from '@server/models/Series';
import { Router } from 'express';

const seriesRoutes = Router();

seriesRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  if (!getSettings().main.hardcoverapikey) {
    return next({
      status: 503,
      message: 'Hardcover API key is not configured.',
    });
  }

  const hardcover = new Hardcover();

  try {
    const series = await hardcover.getSeries(Number(req.params.id));

    const media = await Media.getRelatedMedia(
      req.user,
      series.book_series.map((book) => ({
        tmdbId: book.book.id,
        mediaType: MediaType.BOOK,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json(mapSeries(series, media));
  } catch (e) {
    logger.debug('Something went wrong retrieving series', {
      label: 'API',
      errorMessage: e.message,
      seriesId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series.',
    });
  }
});

export default seriesRoutes;
