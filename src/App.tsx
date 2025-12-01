import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from 'react';
import axios, { AxiosError } from 'axios';
import './App.css';
import { IgniteLogo } from './components/IgniteLogo';

// Types
type ImportStage =
  | 'checking'
  | 'fetching_vimeo'
  | 'downloading'
  | 'creating_video'
  | 'uploading'
  | 'uploading_thumbnail'
  | 'polling'
  | 'complete'
  | 'error';

type CorsTestResult = 'untested' | 'testing' | 'success' | 'failure' | 'error';

interface VimeoVideoData {
  name: string;
  description: string;
  duration: number;
  width: number;
  height: number;
  download?: Array<{
    quality: string;
    type: string;
    width: number;
    height: number;
    size: number;
    link: string;
    public_name: string;
    rendition: string;
  }>;
  pictures?: {
    active: boolean;
    type: string;
    base_link: string;
    sizes: Array<{ width: number; height: number; link: string }>;
  };
}

interface ImportItem {
  id: string;
  vimeoId: string;
  stage: ImportStage;
  progress: number;
  statusText: string;
  vimeoData: VimeoVideoData | null;
  igniteVideoId: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  // Snapshot of options at import time
  options: {
    visibility: 'private' | 'public';
    language: string;
    autoTranscribe: boolean;
    tags: string;
    categoryId: string;
  };
}

const DEFAULT_API_BASE = 'https://app.ignitevideo.cloud/api';
const STORAGE_KEY_IMPORTS = 'vimeo_import_queue';

// Stages that can be resumed or are final
const RESUMABLE_STAGES: ImportStage[] = ['polling'];
const FINAL_STAGES: ImportStage[] = ['complete', 'error'];

function App() {
  // Credentials
  const [vimeoToken, setVimeoToken] = useState<string>('');
  const [igniteToken, setIgniteToken] = useState<string>('');
  const [apiBase, setApiBase] = useState<string>(DEFAULT_API_BASE);

  // Video input
  const [vimeoId, setVimeoId] = useState<string>('');

  // Options
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  const [language, setLanguage] = useState<string>('');
  const [autoTranscribe, setAutoTranscribe] = useState<boolean>(false);
  const [tags, setTags] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('');

  // Import queue
  const [imports, setImports] = useState<ImportItem[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // CORS test
  const [corsResult, setCorsResult] = useState<CorsTestResult>('untested');
  const [corsMessage, setCorsMessage] = useState<string>('');

  // Polling timers (one per import item)
  const pollTimersRef = useRef<Map<string, number>>(new Map());

  // Load saved tokens and imports from localStorage
  useEffect(() => {
    const storedVimeoToken = localStorage.getItem('vimeo_token');
    if (storedVimeoToken) setVimeoToken(storedVimeoToken);

    const storedIgniteToken = localStorage.getItem('ignite_token');
    if (storedIgniteToken) setIgniteToken(storedIgniteToken);

    const storedApiBase = localStorage.getItem('ignite_api_base');
    if (storedApiBase) setApiBase(storedApiBase);

    // Load saved options
    const storedVisibility = localStorage.getItem('import_visibility');
    if (storedVisibility === 'public' || storedVisibility === 'private') {
      setVisibility(storedVisibility);
    }

    const storedLanguage = localStorage.getItem('import_language');
    if (storedLanguage) setLanguage(storedLanguage);

    const storedAutoTranscribe = localStorage.getItem('import_auto_transcribe');
    if (storedAutoTranscribe)
      setAutoTranscribe(storedAutoTranscribe === 'true');

    const storedTags = localStorage.getItem('import_tags');
    if (storedTags) setTags(storedTags);

    const storedCategoryId = localStorage.getItem('import_category_id');
    if (storedCategoryId) setCategoryId(storedCategoryId);

    // Load saved imports
    const storedImports = localStorage.getItem(STORAGE_KEY_IMPORTS);
    if (storedImports) {
      try {
        const parsed: ImportItem[] = JSON.parse(storedImports);
        // Process loaded imports - mark interrupted ones as error
        const processedImports = parsed.map((item) => {
          if (
            FINAL_STAGES.includes(item.stage) ||
            RESUMABLE_STAGES.includes(item.stage)
          ) {
            return item;
          }
          // Import was interrupted mid-process
          return {
            ...item,
            stage: 'error' as ImportStage,
            errorMessage: 'Import was interrupted. Please try again.',
            statusText: 'Interrupted',
          };
        });
        setImports(processedImports);
      } catch (e) {
        console.warn('Failed to parse stored imports:', e);
      }
    }
    setSettingsLoaded(true);
  }, []);

  // Persist tokens and settings - only after initial load to prevent overwriting
  useEffect(() => {
    if (settingsLoaded && vimeoToken) {
      localStorage.setItem('vimeo_token', vimeoToken);
    }
  }, [vimeoToken, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded && igniteToken) {
      localStorage.setItem('ignite_token', igniteToken);
    }
  }, [igniteToken, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded && apiBase) {
      localStorage.setItem('ignite_api_base', apiBase);
    }
  }, [apiBase, settingsLoaded]);

  // Persist options
  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem('import_visibility', visibility);
    }
  }, [visibility, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem('import_language', language);
    }
  }, [language, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem('import_auto_transcribe', String(autoTranscribe));
    }
  }, [autoTranscribe, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem('import_tags', tags);
    }
  }, [tags, settingsLoaded]);

  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem('import_category_id', categoryId);
    }
  }, [categoryId, settingsLoaded]);

  // Persist imports to localStorage whenever they change
  useEffect(() => {
    if (settingsLoaded) {
      localStorage.setItem(STORAGE_KEY_IMPORTS, JSON.stringify(imports));
    }
  }, [imports, settingsLoaded]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      pollTimersRef.current.forEach((timerId) => window.clearInterval(timerId));
      pollTimersRef.current.clear();
    };
  }, []);

  // Check if any imports are actively downloading/uploading
  const hasActiveTransfers = useMemo(() => {
    const activeStages: ImportStage[] = [
      'checking',
      'fetching_vimeo',
      'downloading',
      'creating_video',
      'uploading',
      'uploading_thumbnail',
    ];
    return imports.some((item) => activeStages.includes(item.stage));
  }, [imports]);

  // Warn user before leaving page if transfers are in progress
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasActiveTransfers) {
        e.preventDefault();
        // Most modern browsers ignore custom messages and show a generic one
        e.returnValue =
          'You have imports in progress. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasActiveTransfers]);

  const apiBaseSanitized = useMemo(() => apiBase.replace(/\/$/, ''), [apiBase]);

  const canImport = useMemo(
    () =>
      vimeoToken.trim().length > 0 &&
      igniteToken.trim().length > 0 &&
      vimeoId.trim().length > 0,
    [vimeoToken, igniteToken, vimeoId]
  );

  const canTestCors = useMemo(
    () =>
      vimeoToken.trim().length > 0 &&
      vimeoId.trim().length > 0 &&
      corsResult !== 'testing',
    [vimeoToken, vimeoId, corsResult]
  );

  // Update a specific import item
  const updateImport = useCallback(
    (id: string, updater: (prev: ImportItem) => ImportItem) => {
      setImports((prev) =>
        prev.map((item) => (item.id === id ? updater(item) : item))
      );
    },
    []
  );

  // Extract error from axios
  const extractAxiosError = (error: unknown): string => {
    const err = error as AxiosError<any>;
    if (err.response) {
      const status = err.response.status;
      const data = err.response.data as any;
      const msg =
        (data && (data.message || data.error || JSON.stringify(data))) ||
        'Request failed';
      return `${status}: ${msg}`;
    }
    if (err.request) {
      return 'No response from server';
    }
    return err.message || 'Unknown error';
  };

  // Fetch Vimeo video data
  const fetchVimeoData = async (videoId: string): Promise<VimeoVideoData> => {
    const url = `https://api.vimeo.com/videos/${videoId}`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${vimeoToken}`,
      },
    });
    return response.data;
  };

  // Test CORS by attempting a small range request on the download URL
  const testCors = async () => {
    setCorsResult('testing');
    setCorsMessage('Testing CORS compatibility...');

    try {
      const vimeoData = await fetchVimeoData(vimeoId.trim());

      if (!vimeoData.download || vimeoData.download.length === 0) {
        setCorsResult('error');
        setCorsMessage(
          'No download links available. Make sure your Vimeo token has download access.'
        );
        return;
      }

      const testDownload = vimeoData.download.reduce((smallest, current) =>
        current.size < smallest.size ? current : smallest
      );

      try {
        await axios.head(testDownload.link, {
          headers: { Range: 'bytes=0-0' },
        });
        setCorsResult('success');
        setCorsMessage('CORS test passed! Client-side downloads should work.');
      } catch (corsError) {
        const err = corsError as AxiosError;
        if (!err.response) {
          setCorsResult('failure');
          setCorsMessage(
            'CORS blocked. Vimeo download URLs do not allow browser access.'
          );
        } else {
          setCorsResult('success');
          setCorsMessage(
            'CORS test passed! Client-side downloads should work.'
          );
        }
      }
    } catch (error) {
      setCorsResult('error');
      setCorsMessage(`Failed to fetch Vimeo data: ${extractAxiosError(error)}`);
    }
  };

  // Check if a video with this Vimeo ID already exists in Ignite
  const checkExistingVimeoImport = async (
    vimeoVideoId: string
  ): Promise<{ exists: boolean; videoId?: string; title?: string }> => {
    try {
      const queryString = `where[customMetadata.vimeoId][equals]=${encodeURIComponent(
        vimeoVideoId
      )}&limit=1`;
      const url = `${apiBaseSanitized}/videos?${queryString}`;

      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${igniteToken}` },
      });

      const data = response.data;
      if (data.docs && data.docs.length > 0) {
        return {
          exists: true,
          videoId: data.docs[0].id,
          title: data.docs[0].title,
        };
      }
      return { exists: false };
    } catch (error) {
      console.warn('Failed to check for existing import:', error);
      return { exists: false };
    }
  };

  // Create video in Ignite
  const createIgniteVideo = async (
    title: string,
    vimeoVideoId: string,
    options: ImportItem['options']
  ): Promise<{ videoId: string; signedUrl: string }> => {
    const url = `${apiBaseSanitized}/videos/upload`;

    const payload: any = {
      title: title.substring(0, 100),
      visibility: options.visibility,
      autoTranscribe: options.autoTranscribe,
      customMetadata: { vimeoId: vimeoVideoId },
    };

    if (options.language.trim()) {
      payload.language = options.language.trim();
    }

    if (options.tags.trim()) {
      payload.tags = options.tags
        .split(',')
        .map((t: string) => t.trim())
        .filter((t: string) => t);
    }

    if (options.categoryId.trim()) {
      payload.categories = [options.categoryId.trim()];
    }

    const response = await axios.put(url, payload, {
      headers: {
        Authorization: `Bearer ${igniteToken}`,
        'Content-Type': 'application/json',
      },
    });

    return response.data;
  };

  // Upload video to signed URL
  const uploadToSignedUrl = async (
    signedUrl: string,
    videoBlob: Blob,
    contentType: string,
    onProgress: (percent: number) => void
  ) => {
    await axios.put(signedUrl, videoBlob, {
      headers: { 'Content-Type': contentType },
      onUploadProgress: (evt: { loaded: number; total?: number }) => {
        if (!evt.total) return;
        const percent = Math.round((evt.loaded / evt.total) * 100);
        onProgress(percent);
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      withCredentials: false,
    });
  };

  // Upload thumbnail to Ignite
  const uploadThumbnail = async (
    videoId: string,
    thumbnailBlob: Blob
  ): Promise<string> => {
    const url = `${apiBaseSanitized}/videos/${videoId}/thumbnail`;
    const formData = new FormData();
    formData.append('file', thumbnailBlob, 'thumbnail.jpg');

    const response = await axios.put(url, formData, {
      headers: { Authorization: `Bearer ${igniteToken}` },
    });

    return response.data.customThumbnailUrl || response.data.thumbnailUrl;
  };

  // Poll video status for a specific import
  const pollVideoStatus = useCallback(
    (importId: string, videoId: string) => {
      const intervalMs = 10000;

      // Clear existing timer for this import
      const existing = pollTimersRef.current.get(importId);
      if (existing) window.clearInterval(existing);

      const run = async () => {
        try {
          const response = await axios.get(
            `${apiBaseSanitized}/videos/${videoId}`,
            { headers: { Authorization: `Bearer ${igniteToken}` } }
          );
          const data = response.data;
          const status = (data.status || '').toString().toUpperCase();

          updateImport(importId, (prev) => ({
            ...prev,
            statusText: `Processing: ${status}`,
          }));

          const doneStatuses = ['COMPLETE', 'COMPLETED', 'READY', 'ENCODED'];
          const errorStatuses = ['FAILED', 'ERROR'];

          if (doneStatuses.includes(status)) {
            updateImport(importId, (prev) => ({
              ...prev,
              stage: 'complete',
              statusText: 'Import complete!',
              progress: 100,
            }));
            const t = pollTimersRef.current.get(importId);
            if (t) window.clearInterval(t);
            pollTimersRef.current.delete(importId);
          } else if (errorStatuses.includes(status)) {
            updateImport(importId, (prev) => ({
              ...prev,
              stage: 'error',
              errorMessage: `Encoding failed: ${status}`,
            }));
            const t = pollTimersRef.current.get(importId);
            if (t) window.clearInterval(t);
            pollTimersRef.current.delete(importId);
          }
        } catch (error) {
          console.error('Poll error:', error);
        }
      };

      run();
      const timerId = window.setInterval(run, intervalMs);
      pollTimersRef.current.set(importId, timerId);
    },
    [apiBaseSanitized, igniteToken, updateImport]
  );

  // Resume polling for imports that were in 'polling' stage on page load
  const resumedPollingIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!settingsLoaded || !igniteToken) return;

    // Resume polling for any items in 'polling' stage that we haven't started yet
    imports.forEach((item) => {
      if (
        item.stage === 'polling' &&
        item.igniteVideoId &&
        !resumedPollingIds.current.has(item.id) &&
        !pollTimersRef.current.has(item.id)
      ) {
        resumedPollingIds.current.add(item.id);
        pollVideoStatus(item.id, item.igniteVideoId);
      }
    });
  }, [settingsLoaded, igniteToken, imports, pollVideoStatus]);

  // Main import function - runs the import process for a single item
  const runImport = useCallback(
    async (importItem: ImportItem) => {
      const { id, vimeoId: itemVimeoId, options } = importItem;

      try {
        // Step 0: Check for existing import
        updateImport(id, (prev) => ({
          ...prev,
          statusText: 'Checking for existing import...',
        }));

        const existingCheck = await checkExistingVimeoImport(itemVimeoId);
        if (existingCheck.exists) {
          throw new Error(
            `Already imported (ID: ${existingCheck.videoId}, Title: "${existingCheck.title}")`
          );
        }

        // Step 1: Fetch Vimeo data
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'fetching_vimeo',
          statusText: 'Fetching Vimeo data...',
          progress: 5,
        }));

        const vimeoData = await fetchVimeoData(itemVimeoId);
        updateImport(id, (prev) => ({
          ...prev,
          vimeoData,
          progress: 10,
        }));

        // Validate download links
        if (!vimeoData.download || vimeoData.download.length === 0) {
          throw new Error('No download links available.');
        }

        const downloadOptions = vimeoData.download.filter(
          (d) => d.public_name !== 'source'
        );
        if (downloadOptions.length === 0) {
          throw new Error('No suitable download rendition found.');
        }

        const selectedDownload = downloadOptions.reduce((largest, current) =>
          current.size > largest.size ? current : largest
        );

        // Step 2: Download video from Vimeo
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'downloading',
          statusText: `Downloading (${formatBytes(selectedDownload.size)})...`,
          progress: 15,
        }));

        const videoResponse = await axios.get(selectedDownload.link, {
          responseType: 'blob',
          onDownloadProgress: (evt: { loaded: number; total?: number }) => {
            if (!evt.total) return;
            const percent = Math.round((evt.loaded / evt.total) * 100);
            const downloadProgress = 15 + percent * 0.35;
            updateImport(id, (prev) => ({
              ...prev,
              progress: downloadProgress,
              statusText: `Downloading... ${percent}%`,
            }));
          },
        });

        const videoBlob = videoResponse.data as Blob;

        // Step 3: Create video in Ignite
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'creating_video',
          statusText: 'Creating video in Ignite...',
          progress: 52,
        }));

        const { videoId: igniteVideoId, signedUrl } = await createIgniteVideo(
          vimeoData.name,
          itemVimeoId,
          options
        );

        updateImport(id, (prev) => ({
          ...prev,
          igniteVideoId,
          progress: 55,
        }));

        // Step 4: Upload video to signed URL
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'uploading',
          statusText: 'Uploading to Ignite...',
        }));

        await uploadToSignedUrl(
          signedUrl,
          videoBlob,
          selectedDownload.type,
          (percent: number) => {
            const uploadProgress = 55 + percent * 0.35;
            updateImport(id, (prev) => ({
              ...prev,
              progress: uploadProgress,
              statusText: `Uploading... ${percent}%`,
            }));
          }
        );

        // Step 5: Upload thumbnail if available
        let thumbnailUrl: string | null = null;
        if (
          vimeoData.pictures?.active &&
          vimeoData.pictures.sizes &&
          vimeoData.pictures.sizes.length > 0
        ) {
          updateImport(id, (prev) => ({
            ...prev,
            stage: 'uploading_thumbnail',
            statusText: 'Uploading thumbnail...',
            progress: 92,
          }));

          try {
            const largestThumb = vimeoData.pictures.sizes.reduce(
              (largest, current) =>
                current.width > largest.width ? current : largest
            );

            const thumbResponse = await axios.get(largestThumb.link, {
              responseType: 'blob',
            });

            thumbnailUrl = await uploadThumbnail(
              igniteVideoId,
              thumbResponse.data as Blob
            );

            updateImport(id, (prev) => ({
              ...prev,
              thumbnailUrl,
              progress: 95,
            }));
          } catch (thumbError) {
            console.warn('Thumbnail upload failed:', thumbError);
          }
        }

        // Step 6: Start polling for encoding status
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'polling',
          statusText: 'Processing...',
          progress: 98,
          thumbnailUrl,
        }));

        pollVideoStatus(id, igniteVideoId);
      } catch (error) {
        const errorMessage = extractAxiosError(error);
        updateImport(id, (prev) => ({
          ...prev,
          stage: 'error',
          errorMessage,
          statusText: 'Failed',
        }));

        const t = pollTimersRef.current.get(id);
        if (t) {
          window.clearInterval(t);
          pollTimersRef.current.delete(id);
        }
      }
    },
    [updateImport, pollVideoStatus, apiBaseSanitized, igniteToken, vimeoToken]
  );

  // Start a new import
  const startImport = () => {
    if (!canImport) return;

    const newImport: ImportItem = {
      id: `${Date.now()}-${vimeoId.trim()}`,
      vimeoId: vimeoId.trim(),
      stage: 'checking',
      progress: 0,
      statusText: 'Starting...',
      vimeoData: null,
      igniteVideoId: null,
      thumbnailUrl: null,
      errorMessage: null,
      options: {
        visibility,
        language,
        autoTranscribe,
        tags,
        categoryId,
      },
    };

    setImports((prev) => [newImport, ...prev]);
    setVimeoId(''); // Clear input for next import

    // Start the import process
    runImport(newImport);
  };

  // Remove a completed or errored import from the list
  const removeImport = (id: string) => {
    const t = pollTimersRef.current.get(id);
    if (t) {
      window.clearInterval(t);
      pollTimersRef.current.delete(id);
    }
    setImports((prev) => prev.filter((item) => item.id !== id));
  };

  // Clear all completed/errored imports
  const clearFinished = () => {
    imports.forEach((item) => {
      if (item.stage === 'complete' || item.stage === 'error') {
        const t = pollTimersRef.current.get(item.id);
        if (t) {
          window.clearInterval(t);
          pollTimersRef.current.delete(item.id);
        }
      }
    });
    setImports((prev) =>
      prev.filter((item) => item.stage !== 'complete' && item.stage !== 'error')
    );
  };

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  // Format duration
  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get stage badge class
  const getStageBadgeClass = (stage: ImportStage): string => {
    switch (stage) {
      case 'checking':
      case 'fetching_vimeo':
        return 'fetching';
      case 'downloading':
        return 'downloading';
      case 'creating_video':
      case 'uploading':
      case 'uploading_thumbnail':
        return 'uploading';
      case 'polling':
        return 'processing';
      case 'complete':
        return 'complete';
      case 'error':
        return 'error';
      default:
        return '';
    }
  };

  // Get stage label
  const getStageLabel = (stage: ImportStage): string => {
    const labels: Record<ImportStage, string> = {
      checking: 'Checking',
      fetching_vimeo: 'Fetching',
      downloading: 'Downloading',
      creating_video: 'Creating',
      uploading: 'Uploading',
      uploading_thumbnail: 'Thumbnail',
      polling: 'Processing',
      complete: 'Complete',
      error: 'Error',
    };
    return labels[stage];
  };

  const hasFinishedImports = imports.some(
    (item) => item.stage === 'complete' || item.stage === 'error'
  );

  return (
    <div className="importer-root">
      <header className="header">
        <h1>
          <IgniteLogo className="header-logo" /> Vimeo Importer
        </h1>
        <p>Import videos from Vimeo to Ignite Video Cloud</p>
      </header>

      <div className="main-layout">
        {/* Left Panel - Form */}
        <div className="form-panel">
          {/* Credentials Section */}
          <section className="section">
            <h2 className="section-title">Credentials</h2>

            <div className="form-row">
              <label htmlFor="vimeo-token">Vimeo Token</label>
              <input
                id="vimeo-token"
                type="password"
                placeholder="Your Vimeo API access token"
                value={vimeoToken}
                onChange={(e) => setVimeoToken(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="form-row">
              <label htmlFor="ignite-token">Ignite Token</label>
              <input
                id="ignite-token"
                type="password"
                placeholder="Your Ignite API access token"
                value={igniteToken}
                onChange={(e) => setIgniteToken(e.target.value)}
                autoComplete="off"
              />
            </div>

            <div className="form-row">
              <label htmlFor="api-base">API Base</label>
              <input
                id="api-base"
                type="text"
                placeholder="https://app.ignitevideo.cloud/api"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
              />
            </div>
          </section>

          {/* Video Input Section */}
          <section className="section">
            <h2 className="section-title">Video</h2>

            <div className="form-row">
              <label htmlFor="vimeo-id">Vimeo ID</label>
              <input
                id="vimeo-id"
                type="text"
                placeholder="e.g., 123456789"
                value={vimeoId}
                onChange={(e) => setVimeoId(e.target.value)}
              />
            </div>

            {/* CORS Test */}
            {corsResult !== 'untested' && (
              <div
                className={`cors-result ${
                  corsResult === 'success'
                    ? 'success'
                    : corsResult === 'failure'
                    ? 'failure'
                    : corsResult === 'error'
                    ? 'error'
                    : ''
                }`}
              >
                {corsMessage}
              </div>
            )}
          </section>

          {/* Options Section */}
          <section className="section">
            <h2 className="section-title">Options</h2>

            <div className="form-row">
              <label htmlFor="visibility">Visibility</label>
              <select
                id="visibility"
                value={visibility}
                onChange={(e) =>
                  setVisibility(e.target.value as 'private' | 'public')
                }
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </select>
            </div>

            <div className="form-row">
              <label htmlFor="language">Language</label>
              <input
                id="language"
                type="text"
                placeholder="e.g., en, de, fr (optional)"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
            </div>

            <div className="form-row">
              <label htmlFor="tags">Tags</label>
              <input
                id="tags"
                type="text"
                placeholder="tag1, tag2, tag3"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </div>

            <div className="form-row">
              <label htmlFor="category-id">Category ID</label>
              <input
                id="category-id"
                type="text"
                placeholder="Category ID (optional)"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              />
            </div>

            <div className="form-row">
              <label></label>
              <div className="checkbox-row">
                <input
                  type="checkbox"
                  id="auto-transcribe"
                  checked={autoTranscribe}
                  onChange={(e) => setAutoTranscribe(e.target.checked)}
                />
                <label htmlFor="auto-transcribe">Auto-transcribe</label>
              </div>
            </div>
          </section>

          {/* Actions */}
          <div className="actions">
            <button
              className="btn-primary"
              onClick={startImport}
              disabled={!canImport}
            >
              Add to Queue
            </button>

            <button
              className="btn-test"
              onClick={testCors}
              disabled={!canTestCors}
            >
              {corsResult === 'testing' ? 'Testing...' : 'Test CORS'}
            </button>

            {hasFinishedImports && (
              <button className="btn-secondary" onClick={clearFinished}>
                Clear Finished
              </button>
            )}
          </div>
        </div>

        {/* Right Panel - Queue */}
        <div className="queue-panel">
          <div className="import-queue">
            <h2 className="section-title">Import Queue</h2>

            {imports.length === 0 ? (
              <div className="queue-empty">
                <p>No imports yet</p>
                <span>Enter a Vimeo ID and click "Add to Queue" to start</span>
              </div>
            ) : (
              <div className="queue-list">
                {imports.map((item) => (
                  <div
                    className={`queue-item ${
                      item.stage === 'complete'
                        ? 'complete'
                        : item.stage === 'error'
                        ? 'error'
                        : ''
                    }`}
                    key={item.id}
                  >
                    <div className="queue-item-header">
                      <div className="queue-item-title">
                        {item.vimeoData?.name || `Vimeo ${item.vimeoId}`}
                      </div>
                      <div className="queue-item-actions">
                        <span
                          className={`status-badge ${getStageBadgeClass(
                            item.stage
                          )}`}
                        >
                          {getStageLabel(item.stage)}
                        </span>
                        {(item.stage === 'complete' ||
                          item.stage === 'error' ||
                          item.stage === 'polling') && (
                          <button
                            className="btn-remove"
                            onClick={() => removeImport(item.id)}
                            title="Remove"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="progress-container">
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${item.progress}%` }}
                        />
                      </div>
                      <div className="progress-text">
                        <span>{item.statusText}</span>
                        <span>{Math.round(item.progress)}%</span>
                      </div>
                    </div>

                    {/* Error message */}
                    {item.errorMessage && (
                      <div className="queue-item-error">
                        {item.errorMessage}
                      </div>
                    )}

                    {/* Success link */}
                    {item.stage === 'complete' && item.igniteVideoId && (
                      <div className="queue-item-success">
                        <a
                          href={`${apiBaseSanitized.replace(
                            '/api',
                            ''
                          )}/admin/collections/videos/${item.igniteVideoId}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View in Ignite →
                        </a>
                      </div>
                    )}

                    {/* Video info */}
                    <div className="queue-item-info">
                      {item.vimeoData && (
                        <span>
                          {formatDuration(item.vimeoData.duration)} ·{' '}
                          {item.vimeoData.width}x{item.vimeoData.height}
                        </span>
                      )}
                      <span className="video-ids">
                        <span className="vimeo-id">Vimeo: {item.vimeoId}</span>
                        {item.igniteVideoId && (
                          <span className="ignite-id">
                            Ignite: {item.igniteVideoId}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="footer">
        <span>Vimeo ID is stored in customMetadata.vimeoId</span>
        <div>
          <a
            href="https://docs.ignite.video/api-reference/videos/create"
            target="_blank"
            rel="noreferrer"
          >
            Ignite API docs
          </a>
          {' · '}
          <a
            href="https://developer.vimeo.com/api/reference/videos"
            target="_blank"
            rel="noreferrer"
          >
            Vimeo API docs
          </a>
        </div>
      </footer>
    </div>
  );
}

export default App;
