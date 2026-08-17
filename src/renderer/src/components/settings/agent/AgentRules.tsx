import { Trans, useTranslation } from 'react-i18next';
import { AgentProfile } from '@common/types';

import { PromptSidecarField } from './PromptSidecarField';

import { CodeInline } from '@/components/common/CodeInline';

type AgentRulesProps = {
  profile: AgentProfile;
};

export const AgentRules = ({ profile }: AgentRulesProps) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-2 text-2xs text-text-primary">
      <div>{t('settings.agent.rulesInfo')}</div>
      <div>
        <Trans
          i18nKey="settings.agent.ruleFilesInfo"
          components={{
            file: <CodeInline />,
            a: (
              <a
                href="https://github.com/hotovo/aider-desk/tree/main/.aider-desk/rules"
                target="_blank"
                rel="noopener noreferrer"
                className="text-info-lighter hover:underline"
              />
            ),
          }}
        />
      </div>
      <PromptSidecarField
        profileId={profile.id}
        profileName={profile.name}
        filename="customInstructions.md"
        title={t('settings.agent.customInstructions')}
        label={<div className="text-xs !mt-4 font-medium">{t('settings.agent.customInstructions')}</div>}
        value={profile.customInstructions ?? ''}
      />
    </div>
  );
};
