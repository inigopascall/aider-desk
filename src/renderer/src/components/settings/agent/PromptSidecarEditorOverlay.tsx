import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AiOutlineClose } from 'react-icons/ai';
import { BiReset } from 'react-icons/bi';
import { CgSpinner } from 'react-icons/cg';
import { PromptSidecarFilename } from '@common/types';

import { BaseDialog } from '@/components/common/BaseDialog';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { MarkdownEditor } from '@/components/common/MarkdownEditor';
import { useApi } from '@/contexts/ApiContext';
import { showErrorNotification, showSuccessNotification } from '@/utils/notifications';

type Props = {
  profileId: string;
  profileName: string;
  filename: PromptSidecarFilename;
  /** Human label for the field, e.g. "System Prompt". */
  title: string;
  onClose: () => void;
};

/**
 * Full-screen editor for a single prompt sidecar file. Markdown is the
 * canonical prompt store, so saving writes directly to the `.md` sidecar via
 * the API — config.json is never touched. Closing with unsaved changes asks
 * for confirmation first.
 */
export const PromptSidecarEditorOverlay = ({ profileId, profileName, filename, title, onClose }: Props) => {
  const { t } = useTranslation();
  const api = useApi();

  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  // Load the sidecar content once on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .getAgentPromptSidecar(profileId, filename)
      .then((value) => {
        if (cancelled) {
          return;
        }
        setContent(value);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        showErrorNotification(
          t('settings.agent.promptSidecar.loadError', {
            defaultValue: 'Could not load {{filename}}. If this profile is new, save it first.',
            filename,
          }),
        );
        onClose();
      });
    return () => {
      cancelled = true;
    };
  }, [api, profileId, filename, onClose, t]);

  const handleChange = useCallback((value: string) => {
    setContent(value);
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await api.saveAgentPromptSidecar(profileId, filename, content);
      showSuccessNotification(t('settings.agent.promptSidecar.saved', { defaultValue: 'Saved {{filename}}', filename }));
      setDirty(false);
      onClose();
    } catch (err) {
      showErrorNotification(err instanceof Error ? err.message : String(err));
      // Keep the overlay open so the user can retry or discard.
    }
  }, [api, profileId, filename, content, onClose, t]);

  const requestDiscard = useCallback(() => {
    setShowDiscardConfirm(true);
  }, []);

  const confirmDiscard = useCallback(() => {
    setShowDiscardConfirm(false);
    onClose();
  }, [onClose]);

  const cancelDiscard = useCallback(() => {
    setShowDiscardConfirm(false);
  }, []);

  // Capture-phase document listener so Escape and Ctrl+Enter pre-empt the
  // editor's own keymaps while the overlay is mounted.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.ctrlKey) {
        if (showDiscardConfirm) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (showDiscardConfirm) {
          setShowDiscardConfirm(false);
          return;
        }
        if (dirty) {
          setShowDiscardConfirm(true);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [handleSave, dirty, showDiscardConfirm, onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex flex-col bg-bg-secondary shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-dark-light flex-shrink-0">
          <span className="text-sm text-text-primary">
            {profileName} — {title} ({filename})
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="contained"
              color="primary"
              size="sm"
              onClick={() => void handleSave()}
              disabled={loading || !dirty}
              className="bg-success hover:bg-success-light text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('common.save', { defaultValue: 'Save' })}
            </Button>
            {dirty ? (
              <IconButton
                icon={<BiReset className="w-5 h-5" />}
                onClick={requestDiscard}
                tooltip={t('settings.agent.promptSidecar.discardTooltip', { defaultValue: 'Discard changes and close' })}
              />
            ) : (
              <IconButton icon={<AiOutlineClose className="w-5 h-5" />} onClick={onClose} tooltip={t('promptField.closeEditor')} />
            )}
          </div>
        </div>
        <div className="flex-grow overflow-y-auto scrollbar-thin scrollbar-track-bg-secondary scrollbar-thumb-bg-fourth">
          {loading ? (
            <div className="flex items-center justify-center h-full min-h-[200px]">
              <CgSpinner className="w-6 h-6 animate-spin text-text-muted-light" />
            </div>
          ) : (
            <div className="w-full sm:max-w-[70%] mx-auto flex flex-col px-6 py-6 pb-16 min-h-full">
              <MarkdownEditor value={content} onChange={handleChange} autoFocus large fontSize={16} className="flex-grow [&_.cm-editor]:min-h-[60vh]" />
            </div>
          )}
        </div>
      </div>
      {showDiscardConfirm && (
        <BaseDialog
          title={t('settings.agent.promptSidecar.discardTitle', { defaultValue: 'Discard changes to {{filename}}?', filename })}
          onClose={cancelDiscard}
          width={420}
          closeOnEscape={false}
          footer={
            <>
              <Button onClick={cancelDiscard} variant="text">
                {t('common.cancel')}
              </Button>
              <Button onClick={confirmDiscard} autoFocus variant="contained" color="danger">
                {t('settings.agent.promptSidecar.discardConfirm', { defaultValue: 'Discard' })}
              </Button>
            </>
          }
        >
          <div className="text-xs text-text-secondary">
            {t('settings.agent.promptSidecar.discardBody', {
              defaultValue: 'These changes have not been saved. Discarding will lose them permanently.',
            })}
          </div>
        </BaseDialog>
      )}
    </>,
    document.body,
  );
};
