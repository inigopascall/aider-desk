import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FiMaximize2 } from 'react-icons/fi';
import { PromptSidecarFilename } from '@common/types';

import { PromptSidecarEditorOverlay } from './PromptSidecarEditorOverlay';

import { IconButton } from '@/components/common/IconButton';

type Props = {
  profileId: string;
  profileName: string;
  filename: PromptSidecarFilename;
  /** Rendered above the preview (caller supplies existing label JSX incl. InfoIcon). */
  label: ReactNode;
  /** Plain-text field name passed to the overlay header. */
  title: string;
  /** Hydrated prompt value from the profile (display only). */
  value: string;
  /** Optional caption below the preview. */
  info?: ReactNode;
};

/**
 * Read-only preview of a markdown-canonical prompt field. The field content
 * lives in a `.md` sidecar file; editing happens in a full-screen sidecar
 * editor overlay that saves directly to the file. After a save the backend
 * broadcasts AgentProfilesUpdated and the hydrated `value` prop refreshes.
 */
export const PromptSidecarField = ({ profileId, profileName, filename, label, title, value, info }: Props) => {
  const { t } = useTranslation();
  const [overlayOpen, setOverlayOpen] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {label}
        <IconButton
          icon={<FiMaximize2 className="w-3.5 h-3.5" />}
          onClick={() => setOverlayOpen(true)}
          tooltip={t('settings.agent.promptSidecar.expand', { defaultValue: 'Open in full-screen editor' })}
        />
      </div>
      <pre className="whitespace-pre-wrap break-words text-2xs text-text-secondary bg-bg-secondary-light border border-border-default rounded p-2 max-h-[180px] overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-bg-tertiary cursor-default select-text">
        {value.trim() ? value : t('settings.agent.promptSidecar.empty', { defaultValue: '(empty)' })}
      </pre>
      <div className="text-2xs text-text-muted-light mt-1">
        {t('settings.agent.promptSidecar.managedIn', {
          defaultValue: 'Managed in {{filename}} — edit via the expand button or any external editor.',
          filename,
        })}
      </div>
      {info && <div className="text-2xs text-text-muted-light mt-1">{info}</div>}
      {overlayOpen && (
        <PromptSidecarEditorOverlay
          profileId={profileId}
          profileName={profileName}
          filename={filename}
          title={title}
          onClose={() => setOverlayOpen(false)}
        />
      )}
    </div>
  );
};
