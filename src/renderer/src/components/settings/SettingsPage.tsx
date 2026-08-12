import { McpServersData, ProjectData, ProviderProfile, SettingsData } from '@common/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isEqual } from 'lodash';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from 'react-hotkeys-hook';

import { Settings } from '@/pages/Settings';
import { useSaveSettings, setFont, setFontSize, setTheme, useSettingsStore } from '@/stores/settingsStore';
import { useAgents } from '@/contexts/AgentsContext';
import { ModalOverlayLayout } from '@/components/common/ModalOverlayLayout';
import { useApi } from '@/contexts/ApiContext';
import { Button } from '@/components/common/Button';
import { showErrorNotification, showSuccessNotification } from '@/utils/notifications';

type Props = {
  onClose: () => void;
  initialPageId?: string;
  initialOptions?: Record<string, unknown>;
  openProjects?: ProjectData[];
  onShowLogs?: () => void;
};

export const SettingsPage = ({ onClose, initialPageId, initialOptions, openProjects, onShowLogs }: Props) => {
  const { t, i18n } = useTranslation();
  const api = useApi();

  const originalSettings = useSettingsStore((state) => state.settings);
  const saveSettings = useSaveSettings();
  const { profiles: originalAgentProfiles, createProfile, updateProfile, deleteProfile, updateProfilesOrder } = useAgents();
  const [localSettings, setLocalSettings] = useState<SettingsData | null>(originalSettings);
  const [agentProfiles, setAgentProfiles] = useState(originalAgentProfiles);

  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [originalProviders, setOriginalProviders] = useState<ProviderProfile[]>([]);
  const [workflowsByProject, setWorkflowsByProject] = useState<Record<string, string[]>>({});
  const [originalWorkflowsByProject, setOriginalWorkflowsByProject] = useState<Record<string, string[]>>({});
  const [workflowModelSetIdsByProject, setWorkflowModelSetIdsByProject] = useState<Record<string, Record<string, string>>>({});
  const [originalWorkflowModelSetIdsByProject, setOriginalWorkflowModelSetIdsByProject] = useState<Record<string, Record<string, string>>>({});

  const [mcpServers, setMcpServers] = useState<McpServersData>({ global: {}, projectServers: {} });
  const [originalMcpServers, setOriginalMcpServers] = useState<McpServersData>({ global: {}, projectServers: {} });

  useEffect(() => {
    if (originalSettings) {
      setLocalSettings(originalSettings);
    }
  }, [originalSettings]);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const data = await api.getProviders();
        setProviders(data);
        setOriginalProviders(data);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load providers:', error);
      }
    };

    void loadProviders();
  }, [api]);

  useEffect(() => {
    const loadMcpServers = async () => {
      try {
        const data = await api.getMcpServers();
        setMcpServers(data);
        setOriginalMcpServers(data);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to load MCP servers:', error);
      }
    };

    void loadMcpServers();
  }, [api]);

  useEffect(() => {
    setAgentProfiles(originalAgentProfiles);
  }, [originalAgentProfiles]);

  useEffect(() => {
    if (openProjects && Object.keys(workflowsByProject).length === 0) {
      const map: Record<string, string[]> = {};
      const idsMap: Record<string, Record<string, string>> = {};
      for (const project of openProjects) {
        map[project.baseDir] = project.settings.enabledWorkflows ?? [];
        idsMap[project.baseDir] = project.settings.workflowModelSetIds ?? {};
      }
      setWorkflowsByProject(map);
      setOriginalWorkflowsByProject(map);
      setWorkflowModelSetIdsByProject(idsMap);
      setOriginalWorkflowModelSetIdsByProject(idsMap);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProjects]);

  const hasChanges = useMemo(() => {
    const settingsChanged = localSettings && originalSettings && !isEqual(localSettings, originalSettings);
    const agentProfilesChanged = !isEqual(agentProfiles, originalAgentProfiles);
    const providersChanged = !isEqual(providers, originalProviders);
    const workflowsChanged = !isEqual(workflowsByProject, originalWorkflowsByProject);
    const workflowModelSetIdsChanged = !isEqual(workflowModelSetIdsByProject, originalWorkflowModelSetIdsByProject);
    const mcpServersChanged = !isEqual(mcpServers, originalMcpServers);
    return settingsChanged || agentProfilesChanged || providersChanged || workflowsChanged || workflowModelSetIdsChanged || mcpServersChanged;
  }, [localSettings, originalSettings, agentProfiles, originalAgentProfiles, providers, originalProviders, workflowsByProject, originalWorkflowsByProject, workflowModelSetIdsByProject, originalWorkflowModelSetIdsByProject, mcpServers, originalMcpServers]);

  const handleCancel = useCallback(() => {
    if (originalSettings && localSettings?.language !== originalSettings.language) {
      void i18n.changeLanguage(originalSettings.language);
    }
    if (originalSettings && localSettings?.zoomLevel !== originalSettings.zoomLevel) {
      void api.setZoomLevel(originalSettings.zoomLevel ?? 1);
    }
    if (originalSettings && originalSettings.theme && localSettings?.theme !== originalSettings.theme) {
      setTheme(originalSettings.theme);
    }

    if (originalSettings && originalSettings.font && localSettings?.font !== originalSettings.font) {
      setFont(originalSettings.font);
    }

    if (originalSettings && originalSettings.fontSize && localSettings?.fontSize !== originalSettings.fontSize) {
      setFontSize(originalSettings.fontSize);
    }

    setAgentProfiles(originalAgentProfiles);
    setProviders(originalProviders);
    setWorkflowsByProject(originalWorkflowsByProject);
    setWorkflowModelSetIdsByProject(originalWorkflowModelSetIdsByProject);
    setMcpServers(originalMcpServers);
    onClose();
  }, [
    originalSettings,
    localSettings,
    i18n,
    api,
    originalAgentProfiles,
    originalProviders,
    originalWorkflowsByProject,
    originalWorkflowModelSetIdsByProject,
    originalMcpServers,
    onClose,
  ]);

  const performSave = async (): Promise<boolean> => {
    try {
      if (localSettings) {
        await saveSettings(localSettings);
      }

      // Save provider changes.
      try {
        if (!isEqual(providers, originalProviders)) {
          const updatedProviders = await api.updateProviders(providers);
          setProviders(updatedProviders);
          setOriginalProviders(updatedProviders);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save providers:', error);
        return false;
      }

      // Save workflow availability changes (per-project enabledWorkflows).
      try {
        const changedBaseDirs = Object.keys(workflowsByProject).filter(
          (baseDir) => !isEqual(workflowsByProject[baseDir], originalWorkflowsByProject[baseDir]),
        );
        for (const baseDir of changedBaseDirs) {
          await api.patchProjectSettings(baseDir, { enabledWorkflows: workflowsByProject[baseDir] });
        }
        setOriginalWorkflowsByProject(workflowsByProject);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save workflow availability:', error);
        return false;
      }

      // Save workflow model-set assignments.
      try {
        for (const baseDir of Object.keys(workflowModelSetIdsByProject)) {
          const original = originalWorkflowModelSetIdsByProject[baseDir] ?? {};
          if (!isEqual(workflowModelSetIdsByProject[baseDir], original)) {
            await api.patchProjectSettings(baseDir, { workflowModelSetIds: workflowModelSetIdsByProject[baseDir] });
          }
        }
        setOriginalWorkflowModelSetIdsByProject(workflowModelSetIdsByProject);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save workflow model-set IDs:', error);
        return false;
      }

      // Save MCP server changes.
      try {
        if (!isEqual(mcpServers, originalMcpServers)) {
          const scopes = new Set<string | undefined>([undefined, ...Object.keys(originalMcpServers.projectServers), ...Object.keys(mcpServers.projectServers)]);
          for (const projectDir of scopes) {
            const originalScope = projectDir ? originalMcpServers.projectServers[projectDir] || {} : originalMcpServers.global;
            const draftScope = projectDir ? mcpServers.projectServers[projectDir] || {} : mcpServers.global;
            if (!isEqual(originalScope, draftScope)) {
              await api.replaceMcpServers(draftScope, projectDir);
            }
          }
          setOriginalMcpServers(mcpServers);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save MCP servers:', error);
        return false;
      }

      // Save agent profile changes.
      try {
        const originalProfileIds = new Set(originalAgentProfiles.map((p) => p.id));
        const currentProfileIds = new Set(agentProfiles.map((p) => p.id));

        for (const profileId of originalProfileIds) {
          if (!currentProfileIds.has(profileId)) {
            await deleteProfile(profileId, originalAgentProfiles.find((p) => p.id === profileId)?.projectDir);
          }
        }

        for (const profile of agentProfiles) {
          if (!originalProfileIds.has(profile.id)) {
            await createProfile(profile, profile.projectDir);
          } else {
            const originalProfile = originalAgentProfiles.find((p) => p.id === profile.id);
            if (originalProfile && !isEqual(originalProfile, profile)) {
              await updateProfile(profile, profile.projectDir);
            }
          }
        }

        if (
          !isEqual(
            agentProfiles.map((p) => p.id),
            originalAgentProfiles.map((p) => p.id),
          )
        ) {
          await updateProfilesOrder(agentProfiles);
        }
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('Failed to save agent profiles:', error);
        return false;
      }

      return true;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to save settings:', error);
      return false;
    }
  };

  const handleSave = () => {
    onClose();
    void performSave().then((success) => {
      if (success) {
        showSuccessNotification(t('settings.savedSuccessfully'));
      } else {
        showErrorNotification(t('settings.saveError'));
      }
    });
  };

  useHotkeys(
    'esc',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleCancel();
    },
    { scopes: 'home', enableOnFormTags: true, enableOnContentEditable: true },
    [handleCancel],
  );

  const handleLanguageChange = (language: string) => {
    if (localSettings) {
      setLocalSettings({
        ...localSettings,
        language,
      });
      void i18n.changeLanguage(language);
    }
  };

  const handleZoomChange = (zoomLevel: number) => {
    if (localSettings) {
      setLocalSettings({
        ...localSettings,
        zoomLevel,
      });
      void api.setZoomLevel(zoomLevel);
    }
  };

  return (
    <ModalOverlayLayout title={t('settings.title')}>
      <div className="flex flex-col flex-1 min-h-0">
        {localSettings && (
          <Settings
            settings={localSettings}
            updateSettings={setLocalSettings}
            onLanguageChange={handleLanguageChange}
            onZoomChange={handleZoomChange}
            onThemeChange={setTheme}
            onFontChange={setFont}
            onFontSizeChange={setFontSize}
            initialPageId={initialPageId}
            initialOptions={initialOptions}
            agentProfiles={agentProfiles}
            setAgentProfiles={setAgentProfiles}
            mcpServers={mcpServers}
            setMcpServers={setMcpServers}
            openProjects={openProjects}
            workflowsByProject={workflowsByProject}
            workflowModelSetIdsByProject={workflowModelSetIdsByProject}
            onSetWorkflowModelSetId={(baseDir, workflowId, setId) => {
              setWorkflowModelSetIdsByProject((prev) => {
                const current = prev[baseDir] ?? {};
                const next = { ...current };
                if (setId) {
                  next[workflowId] = setId;
                } else {
                  delete next[workflowId];
                }
                return { ...prev, [baseDir]: next };
              });
            }}
            onToggleWorkflowForProject={(baseDir, workflowId, checked) => {
              setWorkflowsByProject((prev) => {
                const current = prev[baseDir] ?? [];
                const next = checked
                  ? [...new Set([...current, workflowId])]
                  : current.filter((id) => id !== workflowId);
                return { ...prev, [baseDir]: next };
              });
            }}
            providers={providers}
            setProviders={setProviders}
            onShowLogs={onShowLogs}
          />
        )}
      </div>
      <div className="flex items-center justify-end p-3 gap-3 border-t border-border-default-dark">
        <Button variant="text" onClick={handleCancel}>
          {t('common.cancel')}
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges}>
          {t('common.save')}
        </Button>
      </div>
    </ModalOverlayLayout>
  );
};
