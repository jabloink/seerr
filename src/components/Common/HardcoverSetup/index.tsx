import HardcoverLogo from '@app/assets/hardcover.svg';
import Button from '@app/components/Common/Button';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { CogIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.HardcoverSetup', {
  title: 'Book Support Requires Hardcover',
  description:
    'To browse, search, and request books, a Hardcover API key needs to be configured. You can get one from your Hardcover account.',
  opensettings: 'Open Settings',
  getapikey: 'Get an API Key',
  contactadmin: 'Book support is not currently configured on this server.',
  supportnote: 'Consider supporting Hardcover if you enjoy the book features.',
});

const HardcoverSetup = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center text-center text-gray-300 lg:left-64">
      <div className="relative w-full max-w-lg text-center">
        <div className="absolute inset-0 -z-10 mx-auto h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
        <HardcoverLogo className="mx-auto mb-6 w-16" />
        <h1 className="mb-3 text-3xl font-bold text-gray-100">
          {intl.formatMessage(messages.title)}
        </h1>
        <p className="mb-8 text-lg leading-relaxed text-gray-400">
          {intl.formatMessage(messages.description)}
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          {hasPermission(Permission.ADMIN) && (
            <Link href="/settings/main" passHref>
              <Button as="a" buttonType="primary" buttonSize="lg">
                <CogIcon className="mr-1.5 h-5 w-5" />
                {intl.formatMessage(messages.opensettings)}
              </Button>
            </Link>
          )}
          <Button
            as="a"
            buttonType="default"
            buttonSize="lg"
            href="https://hardcover.app/account/api"
            target="_blank"
            rel="noreferrer"
          >
            <HardcoverLogo className="mr-1.5 w-5" />
            {intl.formatMessage(messages.getapikey)}
          </Button>
        </div>
        {!hasPermission(Permission.ADMIN) && (
          <p className="mt-6 text-sm text-gray-500">
            {intl.formatMessage(messages.contactadmin)}
          </p>
        )}
        {hasPermission(Permission.ADMIN) && (
          <p className="mt-6 text-sm text-gray-500">
            {intl.formatMessage(messages.supportnote)}
          </p>
        )}
      </div>
    </div>
  );
};

export default HardcoverSetup;
