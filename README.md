# Vimeo Importer for Ignite

Import videos from Vimeo to Ignite Video Cloud with full metadata and thumbnail support.

## Features

- Import any Vimeo video by ID to your Ignite account
- Automatic thumbnail transfer from Vimeo
- Set video properties: visibility, language, tags, auto-transcribe
- Original Vimeo ID stored in `customMetadata.vimeoId` for reference
- Real-time progress tracking with stage indicators
- CORS compatibility testing before import
- Supports large video files (client-side streaming)

## Quick Start

Requirements: Node 18+ (or latest LTS)

```bash
npm install
npm start
```

Open http://localhost:3000 and:

1. Enter your Vimeo API access token (needs download scope)
2. Enter your Ignite API access token
3. Enter the Vimeo video ID you want to import
4. Optionally configure visibility, language, tags, and auto-transcribe
5. Click "Test CORS" to verify browser compatibility (recommended)
6. Click "Start Import" to begin the transfer

## Build

```bash
npm run build
```

Outputs a static build in `build/` that can be hosted on any static server.

## Configuration

- **Vimeo Token**: Your Vimeo API access token. Must have download permission.
  Get one at https://developer.vimeo.com/apps
- **Ignite Token**: Your Ignite API bearer token. Stored in localStorage.
- **API Base**: Defaults to `https://app.ignitevideo.cloud/api`. Change if using a different Ignite instance.

All tokens are persisted in localStorage for convenience.

## Import Flow

1. **Fetch Vimeo Data** - Retrieves video metadata including available download renditions
2. **Download Video** - Downloads the highest quality non-source rendition
3. **Create in Ignite** - Creates a new video entry with provided metadata
4. **Upload Video** - Uploads the video file to Ignite's S3 storage
5. **Upload Thumbnail** - Transfers the Vimeo thumbnail to Ignite
6. **Processing** - Polls until video encoding is complete

## CORS Considerations

This is a client-side application, meaning all API requests happen in your browser. Some Vimeo download URLs may not include CORS headers, which would prevent browser-based downloads.

Use the "Test CORS" button to verify compatibility before importing. If CORS fails:

- Try a different Vimeo video
- Use a CORS proxy (not included)
- Download the video manually and use the [Bulk Uploader](https://ignitevideo.github.io/bulk-uploader) instead

## API Reference

- **Ignite API**: [Video Upload Docs](https://docs.ignite.video/api-reference/videos/create)
- **Vimeo API**: [Videos Reference](https://developer.vimeo.com/api/reference/videos)

## License

MIT © Contributors
