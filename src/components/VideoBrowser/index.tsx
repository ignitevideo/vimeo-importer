import React, { useState, useCallback, useRef } from 'react';
import axios, { AxiosResponse, AxiosError } from 'axios';

// Rate limiting configuration
const REQUEST_DELAY_MS = 500; // Delay between requests to avoid hitting rate limits
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

// Helper to delay execution
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Types
interface VimeoPaginatedResponse<T> {
  total: number;
  page: number;
  per_page: number;
  data: T[];
  paging?: {
    next: string | null;
    previous: string | null;
    last: string | null;
  };
}

interface VimeoFolder {
  uri: string;
  name: string;
  resource_key: string;
}

// Video object from Vimeo API - includes parent folder info
interface VimeoVideoRaw {
  uri: string;
  name: string;
  type: string; // "video" for VOD, "live" for live events
  download?: Array<{
    quality: string;
    rendition: string;
    size: number;
    width: number;
    height: number;
  }>;
  parent_folder?: {
    uri: string;
    name: string;
    metadata?: {
      connections?: {
        ancestor_path?: Array<{
          uri: string;
          name: string;
        }>;
      };
    };
  } | null;
}

interface VimeoVideoInfo {
  vimeoId: string;
  title: string;
  folderId: string | null;
  folderName: string | null;
  folderPath: string | null; // Full path like "Root/Parent/Child"
  fileSize: number | null; // Size in bytes of largest download
}

interface FetchProgress {
  status: 'idle' | 'fetching' | 'complete' | 'error';
  currentPage: number;
  totalPages: number;
  totalVideos: number;
  errorMessage: string | null;
}

type ViewMode = 'flat' | 'grouped';

interface VideoBrowserProps {
  vimeoToken: string;
}

export function VideoBrowser({ vimeoToken }: VideoBrowserProps) {
  const [videos, setVideos] = useState<VimeoVideoInfo[]>([]);
  const [folders, setFolders] = useState<
    Map<string, { name: string; path: string }>
  >(new Map()); // folderId -> {name, path}
  const [progress, setProgress] = useState<FetchProgress>({
    status: 'idle',
    currentPage: 0,
    totalPages: 0,
    totalVideos: 0,
    errorMessage: null,
  });
  const [viewMode, setViewMode] = useState<ViewMode>('grouped');

  // Team library support - optional user ID to fetch from (e.g., team owner)
  const [teamOwnerId, setTeamOwnerId] = useState<string>('');

  // Rate limit tracking
  const [rateLimitInfo, setRateLimitInfo] = useState<string>('');
  const lastRequestTime = useRef<number>(0);

  // Rate-limited API request helper with retry logic
  const rateLimitedRequest = async <T,>(
    url: string
  ): Promise<AxiosResponse<T>> => {
    // Ensure minimum delay between requests
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime.current;
    if (timeSinceLastRequest < REQUEST_DELAY_MS) {
      await delay(REQUEST_DELAY_MS - timeSinceLastRequest);
    }

    let retries = 0;
    let retryDelay = INITIAL_RETRY_DELAY_MS;

    while (true) {
      try {
        lastRequestTime.current = Date.now();
        const response = await axios.get<T>(url, {
          headers: { Authorization: `Bearer ${vimeoToken}` },
        });

        // Update rate limit info from headers
        const remaining = response.headers['x-ratelimit-remaining'];
        const limit = response.headers['x-ratelimit-limit'];
        if (remaining && limit) {
          setRateLimitInfo(`API: ${remaining}/${limit} requests remaining`);
        }

        return response;
      } catch (error) {
        const axiosError = error as AxiosError;

        // Check if it's a rate limit error (429)
        if (axiosError.response?.status === 429) {
          retries++;
          if (retries > MAX_RETRIES) {
            throw new Error(
              'Rate limit exceeded. Please wait a few minutes and try again.'
            );
          }

          // Get retry delay from header or use exponential backoff
          const retryAfter = axiosError.response.headers['retry-after'];
          const waitTime = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : retryDelay;

          setRateLimitInfo(
            `Rate limited. Waiting ${Math.ceil(
              waitTime / 1000
            )}s before retry ${retries}/${MAX_RETRIES}...`
          );
          await delay(waitTime);
          retryDelay *= 2; // Exponential backoff
          continue;
        }

        // Re-throw other errors
        throw error;
      }
    }
  };

  // Get the base path for API calls (use team owner if specified, otherwise /me)
  const getBasePath = () => {
    if (teamOwnerId.trim()) {
      return `https://api.vimeo.com/users/${teamOwnerId.trim()}`;
    }
    return 'https://api.vimeo.com/me';
  };

  // Calculate total pages from total count and per_page
  const calculateTotalPages = (total: number, perPage: number): number => {
    return Math.ceil(total / perPage);
  };

  // Extract video ID from URI (e.g., "/videos/123456789" -> "123456789")
  const extractVideoId = (uri: string): string => {
    const match = uri.match(/\/videos\/(\d+)/);
    return match ? match[1] : uri;
  };

  // Extract folder ID from URI (e.g., "/users/123/projects/456" -> "456")
  const extractFolderId = (uri: string): string => {
    const match = uri.match(/\/projects\/(\d+)/);
    return match ? match[1] : uri;
  };

  // Main fetch function - fetches all videos directly with pagination
  const fetchAllData = useCallback(async () => {
    if (!vimeoToken.trim()) {
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        errorMessage:
          'Please enter a Vimeo token in the Credentials section of the Importer tab.',
      }));
      return;
    }

    setVideos([]);
    setFolders(new Map());
    setProgress({
      status: 'fetching',
      currentPage: 0,
      totalPages: 0,
      totalVideos: 0,
      errorMessage: null,
    });

    try {
      const basePath = getBasePath();
      const allVideoInfos: VimeoVideoInfo[] = [];
      const folderMap = new Map<string, { name: string; path: string }>();
      let currentPage = 1;
      let totalPages = 1;
      let nextUrl: string | null = `${basePath}/videos?per_page=100`;

      while (nextUrl) {
        const response: AxiosResponse<VimeoPaginatedResponse<VimeoVideoRaw>> =
          await rateLimitedRequest<VimeoPaginatedResponse<VimeoVideoRaw>>(
            nextUrl
          );

        const data = response.data;

        // Update total pages on first request
        if (currentPage === 1) {
          totalPages = calculateTotalPages(data.total, 100);
          setProgress((prev) => ({
            ...prev,
            totalPages,
            totalVideos: data.total,
          }));
        }

        // Process videos (filter out live events, only include VOD)
        if (data.data) {
          for (const video of data.data) {
            // Skip live events - only include regular videos
            if (video.type !== 'video') {
              continue;
            }

            const videoId = extractVideoId(video.uri);
            let folderId: string | null = null;
            let folderName: string | null = null;
            let folderPath: string | null = null;

            // Extract folder info from parent_folder if present
            if (video.parent_folder) {
              folderId = extractFolderId(video.parent_folder.uri);
              folderName = video.parent_folder.name;

              // Build folder path from ancestor_path (reverse order: root first)
              const ancestorPath =
                video.parent_folder.metadata?.connections?.ancestor_path;
              if (ancestorPath && ancestorPath.length > 0) {
                // ancestor_path is ordered from immediate parent to root, so reverse it
                const pathParts = [...ancestorPath]
                  .reverse()
                  .map((a) => a.name);
                // Add the current folder name at the end
                pathParts.push(folderName);
                folderPath = pathParts.join('/');
              } else {
                // No ancestors, just use the folder name
                folderPath = folderName;
              }

              // Add to folder map for grouping (with path)
              if (!folderMap.has(folderId)) {
                folderMap.set(folderId, { name: folderName, path: folderPath });
              }
            }

            // Get file size from largest download (excluding 'source')
            let fileSize: number | null = null;
            if (video.download && video.download.length > 0) {
              const largestDownload = video.download
                .filter((d) => d.rendition !== 'source')
                .reduce(
                  (largest, current) =>
                    current.size > largest.size ? current : largest,
                  video.download[0]
                );
              fileSize = largestDownload.size;
            }

            allVideoInfos.push({
              vimeoId: videoId,
              title: video.name,
              folderId,
              folderName,
              folderPath,
              fileSize,
            });
          }
        }

        setProgress((prev) => ({
          ...prev,
          currentPage,
          totalVideos: allVideoInfos.length,
        }));

        // Move to next page
        nextUrl = data.paging?.next
          ? `https://api.vimeo.com${data.paging.next}`
          : null;
        currentPage++;
      }

      setFolders(folderMap);
      setVideos(allVideoInfos);
      setProgress((prev) => ({
        ...prev,
        status: 'complete',
        currentPage: totalPages,
        totalVideos: allVideoInfos.length,
      }));
    } catch (error: any) {
      const errorMessage =
        error.response?.data?.error ||
        error.response?.data?.message ||
        error.message ||
        'Failed to fetch data';
      setProgress((prev) => ({
        ...prev,
        status: 'error',
        errorMessage: `Error: ${errorMessage}`,
      }));
    }
  }, [vimeoToken, teamOwnerId]);

  // Convert bytes to megabytes (as number for sorting)
  const bytesToMB = (bytes: number): string => {
    return (bytes / (1024 * 1024)).toFixed(2);
  };

  // Generate CSV content
  const generateCSV = (): string => {
    const headers = [
      'Vimeo ID',
      'Title',
      'Folder ID',
      'Folder Name',
      'Folder Path',
      'File Size (MB)',
    ];
    const rows = videos.map((v) => [
      v.vimeoId,
      `"${v.title.replace(/"/g, '""')}"`, // Escape quotes in title
      v.folderId || '',
      v.folderName ? `"${v.folderName.replace(/"/g, '""')}"` : '',
      v.folderPath ? `"${v.folderPath.replace(/"/g, '""')}"` : '',
      v.fileSize ? bytesToMB(v.fileSize) : '',
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  };

  // Download CSV file
  const downloadCSV = () => {
    const csv = generateCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vimeo-videos-${
      new Date().toISOString().split('T')[0]
    }.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Generate Folders CSV content
  const generateFoldersCSV = (): string => {
    const headers = ['Folder ID', 'Folder Name', 'Folder Path'];
    const rows = Array.from(folders.entries()).map(([id, folder]) => [
      id,
      `"${folder.name.replace(/"/g, '""')}"`, // Escape quotes in name
      `"${folder.path.replace(/"/g, '""')}"`, // Escape quotes in path
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  };

  // Download Folders CSV file
  const downloadFoldersCSV = () => {
    const csv = generateFoldersCSV();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vimeo-folders-${
      new Date().toISOString().split('T')[0]
    }.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Group videos by folder for grouped view
  const groupedVideos = React.useMemo(() => {
    const groups = new Map<string | null, VimeoVideoInfo[]>();

    // Initialize with all folders (even empty ones)
    folders.forEach((name, id) => {
      groups.set(id, []);
    });
    groups.set(null, []); // Root level

    // Add videos to their groups
    videos.forEach((video) => {
      const group = groups.get(video.folderId) || [];
      group.push(video);
      groups.set(video.folderId, group);
    });

    return groups;
  }, [videos, folders]);

  const isFetching = progress.status === 'fetching';

  return (
    <div className="video-browser">
      {/* Team Library Settings */}
      <section className="section browser-settings">
        <h2 className="section-title">Settings</h2>
        <div className="form-row">
          <label htmlFor="team-owner-id">Team Owner ID</label>
          <input
            id="team-owner-id"
            type="text"
            placeholder="Leave empty for personal library, or enter team owner's user ID"
            value={teamOwnerId}
            onChange={(e) => setTeamOwnerId(e.target.value)}
          />
        </div>
        <p className="settings-hint">
          For team libraries, enter the user ID of the team owner. You can find
          this in the Vimeo URL when viewing the team owner's profile (e.g.,
          vimeo.com/user/<strong>123456789</strong>).
        </p>
      </section>

      {/* Controls */}
      <div className="browser-controls">
        <div className="browser-actions">
          <button
            className="btn-primary"
            onClick={fetchAllData}
            disabled={isFetching || !vimeoToken.trim()}
          >
            {isFetching ? 'Fetching...' : 'Fetch All Videos'}
          </button>

          {videos.length > 0 && (
            <button className="btn-secondary" onClick={downloadCSV}>
              Download Videos CSV
            </button>
          )}
          {folders.size > 0 && (
            <button className="btn-secondary" onClick={downloadFoldersCSV}>
              Download Folders CSV
            </button>
          )}
        </div>

        {videos.length > 0 && (
          <div className="view-toggle">
            <button
              className={`toggle-btn ${viewMode === 'grouped' ? 'active' : ''}`}
              onClick={() => setViewMode('grouped')}
            >
              Grouped
            </button>
            <button
              className={`toggle-btn ${viewMode === 'flat' ? 'active' : ''}`}
              onClick={() => setViewMode('flat')}
            >
              Flat List
            </button>
          </div>
        )}
      </div>

      {/* Progress / Status */}
      {progress.status !== 'idle' && (
        <div className="browser-progress">
          {progress.status === 'fetching' && (
            <div className="progress-info">
              <span className="spinner"></span>
              Fetching videos... Page {progress.currentPage} of{' '}
              {progress.totalPages || '?'}
              {progress.totalVideos > 0 && ` (${progress.totalVideos} total)`}
            </div>
          )}
          {progress.status === 'complete' && (
            <div className="progress-complete">
              Found {progress.totalVideos} videos
              {folders.size > 0 && ` in ${folders.size} folders`}
            </div>
          )}
          {progress.status === 'error' && (
            <div className="progress-error">{progress.errorMessage}</div>
          )}
          {rateLimitInfo && progress.status === 'fetching' && (
            <div className="rate-limit-info">{rateLimitInfo}</div>
          )}
        </div>
      )}

      {/* Video List */}
      {videos.length > 0 && (
        <div className="browser-content">
          {viewMode === 'flat' ? (
            <div className="video-table-container">
              <table className="video-table">
                <thead>
                  <tr>
                    <th>Vimeo ID</th>
                    <th>Title</th>
                    <th>Folder ID</th>
                    <th>Folder Path</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((video) => (
                    <tr key={video.vimeoId}>
                      <td className="mono">{video.vimeoId}</td>
                      <td>{video.title}</td>
                      <td className="mono">{video.folderId || '—'}</td>
                      <td>{video.folderPath || '(Root)'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="folder-groups">
              {Array.from(groupedVideos.entries()).map(
                ([folderId, folderVideos]) => {
                  const folderData = folderId ? folders.get(folderId) : null;
                  const folderName = folderId
                    ? folderData?.name || folderId
                    : '(Root - No Folder)';
                  if (folderVideos.length === 0) return null;

                  return (
                    <FolderGroup
                      key={folderId || 'root'}
                      folderId={folderId}
                      folderName={folderName}
                      videos={folderVideos}
                    />
                  );
                }
              )}
            </div>
          )}
        </div>
      )}

      {/* Empty State */}
      {progress.status === 'idle' && videos.length === 0 && (
        <div className="browser-empty">
          <p>No videos loaded</p>
          <span>
            Click "Fetch All Videos" to load videos from your Vimeo account
          </span>
        </div>
      )}
    </div>
  );
}

// Collapsible folder group component
interface FolderGroupProps {
  folderId: string | null;
  folderName: string;
  videos: VimeoVideoInfo[];
}

function FolderGroup({ folderId, folderName, videos }: FolderGroupProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="folder-group">
      <button
        className="folder-header"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className={`folder-icon ${isExpanded ? 'expanded' : ''}`}>▶</span>
        <span className="folder-name">{folderName}</span>
        <span className="folder-count">{videos.length} videos</span>
        {folderId && <span className="folder-id">ID: {folderId}</span>}
      </button>
      {isExpanded && (
        <div className="folder-videos">
          {videos.map((video) => (
            <div key={video.vimeoId} className="folder-video-item">
              <span className="video-id mono">{video.vimeoId}</span>
              <span className="video-title">{video.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
