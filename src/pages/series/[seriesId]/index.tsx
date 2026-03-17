import SeriesDetails from '@app/components/SeriesDetails';
import { getHostAndPort } from '@app/utils/urlHelper';
import type { Series } from '@server/models/Series';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';

interface SeriesPageProps {
  series?: Series;
}

const SeriesPage: NextPage<SeriesPageProps> = ({ series }) => {
  return <SeriesDetails series={series} />;
};

export const getServerSideProps: GetServerSideProps<SeriesPageProps> = async (
  ctx
) => {
  try {
    const response = await axios.get<Series>(
      `http://${getHostAndPort()}/api/v1/series/${ctx.query.seriesId}`,
      {
        headers: ctx.req?.headers?.cookie
          ? { cookie: ctx.req.headers.cookie }
          : undefined,
      }
    );

    return {
      props: {
        series: response.data,
      },
    };
  } catch {
    return { props: {} };
  }
};

export default SeriesPage;
