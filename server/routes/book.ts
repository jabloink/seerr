import Hardcover from '@server/api/hardcover';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapBookDetails } from '@server/models/Book';
import { Router } from 'express';

const bookRoutes = Router();

bookRoutes.get('/:id', async (req, res, next) => {
  if (!getSettings().main.hardcoverapikey) {
    return next({
      status: 503,
      message: 'Hardcover API key is not configured.',
    });
  }

  const hardcover = new Hardcover();

  try {
    const hardcoverBook = await hardcover.getBook(Number(req.params.id));

    const media = await Media.getMedia(hardcoverBook.id, MediaType.BOOK);

    return res
      .status(200)
      .json(mapBookDetails(hardcoverBook, media?.filter(req.user)));
  } catch (e) {
    logger.debug('Something went wrong retrieving book', {
      label: 'API',
      errorMessage: e.message,
      bookId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve book.',
    });
  }
});

export default bookRoutes;
