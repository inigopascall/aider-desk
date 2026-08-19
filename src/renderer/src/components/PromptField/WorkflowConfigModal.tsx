import { useTranslation } from 'react-i18next';
import { WorkflowInfo } from '@common/types';

import { BaseDialog } from '@/components/common/BaseDialog';
import { Button } from '@/components/common/Button';

type Props = {
  workflow: WorkflowInfo;
  onCancel: () => void;
  onSaveAndClose: () => void;
  onSaveAndGo: () => void;
};

/**
 * CTA modal opened when a workflow button is clicked.
 * Stub for now: per-workflow configuration (model sets, agents, ...) will be
 * mounted here later. Cancel closes without changes, Save & Close keeps the
 * workflow selected for the next prompt, and Save & Go selects the workflow
 * and dispatches it immediately.
 */
export const WorkflowConfigModal = ({ workflow, onCancel, onSaveAndClose, onSaveAndGo }: Props) => {
  const { t } = useTranslation();

  return (
    <BaseDialog
      title={t('workflowsSettings.configModalTitle', { name: workflow.name })}
      onClose={onCancel}
      closeOnEscape
      width={420}
      footer={
        <>
          <Button variant="text" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="text" onClick={onSaveAndClose}>
            {t('workflowsSettings.saveAndClose')}
          </Button>
          <Button onClick={onSaveAndGo}>{t('workflowsSettings.saveAndGo')}</Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">{t('workflowsSettings.configModalPlaceholder')}</p>
    </BaseDialog>
  );
};

export default WorkflowConfigModal;