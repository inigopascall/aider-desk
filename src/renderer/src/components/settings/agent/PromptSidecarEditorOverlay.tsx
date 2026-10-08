import { CSSProperties, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AiOutlineClose } from 'react-icons/ai';
import { BiReset } from 'react-icons/bi';
import { CgSpinner } from 'react-icons/cg';
import { PromptSidecarFilename } from '@common/types';

import { MilkdownEditor, type MilkdownEditorRef } from '@/components/PromptField/MilkdownEditor';
import { SystemPromptEditor } from '@/components/settings/agent/SystemPromptEditor';
import { BaseDialog } from '@/components/common/BaseDialog';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Tooltip } from '@/components/ui/Tooltip';
import { useApi } from '@/contexts/ApiContext';
import { sanitizeMilkdownMarkdown } from '@/utils/markdown';
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
 * the API — config.json is never touched. Rendered (Milkdown) mode and raw
 * textarea mode are both supported, with an unsaved-changes guard on close.
 */
export const PromptSidecarEditorOverlay = ({ profileId, profileName, filename, title, onClose }: Props) => {
  const { t } = useTranslation();
  const api = useApi();

  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showRendered, setShowRendered] = useState(true);
  // Bumped on each raw → rendered switch so Milkdown remounts and reseeds
  // its defaultValueCtx with the current raw text.
  const [remountCounter, setRemountCounter] = useState(0);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const milkdownRef = useRef<MilkdownEditorRef>(null);
  const milkdownReadyRef = useRef(false);

  // Load the sidecar content once on mount.
  useEffect(() => {
    let cancelled = false;
    api
      .getAgentPromptSidecar(profileId, filename)
      .then((value) => {
        if (cancelled) return;
        setContent(value);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
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

  const switchToRaw = useCallback(() => {
    // Capture the current Milkdown value (covers any in-flight debounced
    // changes), sanitize it, then swap the editor component.
    const md = milkdownRef.current?.getMarkdown();
    setContent(sanitizeMilkdownMarkdown(md !== undefined ? md : content));
    setShowRendered(false);
  }, [content]);

  const switchToRendered = useCallback(() => {
    milkdownReadyRef.current = false;
    setShowRendered(true);
    setRemountCounter((c) => c + 1);
  }, []);

  const handleMilkdownReady = useCallback(() => {
    milkdownReadyRef.current = true;
    milkdownRef.current?.focus();
  }, []);

  const handleSave = useCallback(async () => {
    const value = showRendered ? sanitizeMilkdownMarkdown(milkdownRef.current?.getMarkdown() ?? content) : content;
    try {
      await api.saveAgentPromptSidecar(profileId, filename, value);
      showSuccessNotification(t('settings.agent.promptSidecar.saved', { defaultValue: 'Saved {{filename}}', filename }));
      setDirty(false);
      onClose();
    } catch (err) {
      showErrorNotification(err instanceof Error ? err.message : String(err));
      // Keep the overlay open so the user can retry or discard.
    }
  }, [api, profileId, filename, content, showRendered, onClose, t]);

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

  // Capture-phase document listener so Escape and Ctrl+Enter pre-empt
  // ProseMirror/textarea keymaps while the overlay is mounted.
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
          {/* Toggle between rendered Milkdown and raw textarea mode */}
          <Tooltip content={showRendered ? t('promptField.switchToRawEditor') : t('promptField.switchToRenderedEditor')}>
            <button
              type="button"
              onClick={showRendered ? switchToRaw : switchToRendered}
              className="text-text-muted-light hover:text-text-tertiary hover:bg-bg-tertiary rounded p-1 transition-all duration-200"
              aria-label={showRendered ? t('promptField.switchToRawEditor') : t('promptField.switchToRenderedEditor')}
            >
              {showRendered ? (
                // Raw mode icon: represents plain text
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              ) : (
                // Rendered mode icon: represents preview/rendered view
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </Tooltip>
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
          <div
            className="w-full sm:max-w-[70%] mx-auto flex flex-col px-6 py-6 pb-16 min-h-full milkdown-prompt-editor"
            style={{ '--prompt-editor-font-size': '16px' } as CSSProperties}
          >
            {showRendered ? (
              // Remount Milkdown when switching back to rendered mode via a
              // mode-dependent key so its defaultValueCtx is seeded with the
              // current content.
              <MilkdownEditor
                key={`rendered-${remountCounter}`}
                ref={milkdownRef}
                initialValue={content}
                onChange={(md) => {
                  if (!milkdownReadyRef.current) {
                    return;
                  }
                  setContent(sanitizeMilkdownMarkdown(md));
                  setDirty(true);
                }}
                onReady={handleMilkdownReady}
              />
            ) : (
              <SystemPromptEditor
                value={content}
                onChange={(v) => {
                  setContent(v);
                  setDirty(true);
                }}
                className="min-h-[60vh]"
              />
            )}
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
