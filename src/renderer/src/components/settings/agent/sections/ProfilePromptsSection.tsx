import { AgentProfile } from '@common/types';
import { useTranslation } from 'react-i18next';

import { AgentRules } from '../AgentRules';
import { PromptSidecarField } from '../PromptSidecarField';

import { InfoIcon } from '@/components/common/InfoIcon';

type Props = {
  profile: AgentProfile;
};

export const ProfilePromptsSection = ({ profile }: Props) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <PromptSidecarField
        profileId={profile.id}
        profileName={profile.name}
        filename="systemPrompt.md"
        title={t('settings.agent.systemPrompt')}
        label={
          <div className="flex items-center">
            <span>{t('settings.agent.systemPrompt')}</span>
            <InfoIcon className="ml-1" tooltip={t('settings.agent.systemPromptTooltip')} />
          </div>
        }
        value={profile.systemPrompt ?? ''}
        info={t('settings.agent.systemPromptInfo')}
      />

      <div className="border-t border-border-default-dark pt-4">
        <div className="text-sm font-medium text-text-primary mb-3">{t('settings.agent.rules')}</div>
        <AgentRules profile={profile} />
      </div>
    </div>
  );
};
