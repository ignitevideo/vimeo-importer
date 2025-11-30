// This is the old importer script for Vimeo videos. It is no longer used and is kept here for reference.

import axios from 'axios';
import { userOrApiAccess } from '@/access/userOrApiAccess';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { secureIgniteAwsSettings } from '@/utilities/aws/secureIgniteAwsSettings';
import { Payload, PayloadHandler, PayloadRequest } from 'payload';
import { addDataAndFileToRequest } from '@/utilities/addDataAndFileToRequest';
import { Video } from '@/payload-types';
import { encodeImageFile } from '@/utilities/aws/encodeImageFile';

export const vimeoImport: PayloadHandler = async (
  req: PayloadRequest
): Promise<Response> => {
  await addDataAndFileToRequest(req);
  const body = req.data;

  if (!body?.vimeoId) {
    return Response.json({ error: 'vimeo ID is missing' }, { status: 400 });
  }

  if (!body?.vimeoToken) {
    return Response.json(
      { error: 'vimeo access token is missing' },
      { status: 400 }
    );
  }

  const access = await userOrApiAccess('create', { level: 'superadmin' }, req);
  if (!access) {
    return Response.json(
      { error: 'You are not allowed to perform this action.' },
      { status: 403 }
    );
  }

  const vimeoId = body.vimeoId;
  const vimeoToken = body.vimeoToken;

  // check if video with vimeoId already exists
  const existingVimeoVideos = await req.payload.find({
    context: { bypassHooks: true },
    collection: 'videos',
    depth: 0,
    limit: 1,
    where: {
      'customMetadata.vimeoId': {
        equals: vimeoId,
      },
    },
  });
  if (existingVimeoVideos && existingVimeoVideos.docs.length > 0) {
    // If requested fetch and update thumbnail image
    const existingVimeoVideo = existingVimeoVideos.docs[0];
    if (body.fetchThumbnail === true) {
      if (existingVimeoVideo.status !== 'COMPLETE') {
        return Response.json(
          {
            error:
              'Video with this Vimeo ID already exists. Cannot fetch thumbnail. Video is not encoded yet.',
          },
          { status: 400 }
        );
      }
      if (!existingVimeoVideo.customThumbnailUrl) {
        try {
          const updatedVideo = await fetchAndUpdateVimeoThumbnail(
            vimeoId,
            vimeoToken,
            existingVimeoVideo,
            req
          );
          return Response.json(
            {
              id: updatedVideo.id,
              title: updatedVideo.title,
              thumbnailUrl: updatedVideo.customThumbnailUrl,
            },
            { status: 200 }
          );
        } catch (error) {
          req.payload.logger.error({
            msg: ':: VIMEO IMPORT :: Failed to fetch and update Vimeo thumbnail',
            error: error,
          });
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 }
          );
        }
      } else {
        return Response.json(
          {
            error:
              'Video with this Vimeo ID already exists and already has a custom thumbnail image',
          },
          { status: 400 }
        );
      }
    } else {
      return Response.json(
        { error: 'Video with this Vimeo ID already exists' },
        { status: 400 }
      );
    }
  }

  // Fetch Vimeo video data
  const vimeoData = await getVimeoData(vimeoId, vimeoToken);
  if (!vimeoData) {
    return Response.json(
      { error: 'Failed to fetch Vimeo video data' },
      { status: 400 }
    );
  }

  const vimeoDownloads = vimeoData?.download;
  if (!vimeoDownloads) {
    return Response.json(
      { error: 'Vimeo video has no downloads' },
      { status: 400 }
    );
  }

  const vimeoLargestVideo = vimeoDownloads
    .filter((item: any) => item.public_name !== 'source')
    .reduce((largest: any, current: any) => {
      if (current.size > largest.size) {
        return current;
      }
      return largest;
    });
  const vimeoDownloadUrl = vimeoLargestVideo.link;
  const vimeoDownloadType = vimeoLargestVideo.type;
  const vimeoResolution = vimeoLargestVideo.rendition;
  const vimeoFileSize = vimeoLargestVideo.size;
  const extension = vimeoDownloadType.split('/')[1];

  // check if file size is greater than 100MB
  const maxFileSizeMB = 100;
  if (vimeoFileSize > maxFileSizeMB * 1024 * 1024) {
    return Response.json(
      {
        error: `Video is too large, max size is ${maxFileSizeMB} MB (${(
          vimeoFileSize /
          1024 /
          1024
        ).toFixed(2)} MB)`,
      },
      { status: 400 }
    );
  }

  const videoData = {
    title: vimeoData.name.substring(0, 100),
    customMetadata: {
      vimeoId: vimeoId,
    },
    categories:
      body.categories && Array.isArray(body.categories) ? body.categories : [], // Add categories if set
    createdBy: null,
    workspace: access.workspace.id,
    visibility: 'public' as Video['visibility'],
  };

  // Create Video
  const newVideo = await req.payload.create({
    collection: 'videos',
    data: videoData,
  });

  const igniteAwsSettings = secureIgniteAwsSettings();
  if (!igniteAwsSettings) {
    return Response.json(
      { error: 'No AWS S3 crendentials found' },
      { status: 400 }
    );
  }

  const s3ClientParams = {
    region: igniteAwsSettings.region as string,
    credentials: {
      accessKeyId: igniteAwsSettings.accessKeyId as string,
      secretAccessKey: igniteAwsSettings.secretAccessKey as string,
    },
  };

  const s3Client = new S3Client(s3ClientParams);
  const fileKey = `videos/${newVideo.id}/video.${extension}`;

  const s3File = await uploadVideoFromUrlToS3(
    vimeoDownloadUrl,
    fileKey,
    igniteAwsSettings.bucket || '',
    access.workspace.awsSettings?.bucket || '',
    s3Client,
    access.workspace.slug,
    req.payload
  );
  if (!s3File) {
    return Response.json(
      { error: 'Failed to upload video to S3' },
      { status: 400 }
    );
  }

  return Response.json(
    {
      id: newVideo.id,
      ...videoData,
      inputResolution: vimeoResolution,
      uploaded_file_url: s3File,
    },
    { status: 200 }
  );
};

const getVimeoData = async (vimeoId: string, vimeoToken: string) => {
  const url = `https://api.vimeo.com/videos/${vimeoId}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${vimeoToken}`,
    },
  });
  if (!response.ok) {
    return false;
  }
  const data = await response.json();
  if (!data) {
    return false;
  }
  return data;
};

const uploadVideoFromUrlToS3 = async (
  videoUrl: string,
  fileKey: string,
  inputBucketName: string,
  streamBucketName: string,
  s3Client: S3Client,
  workspaceSlug: string,
  payload: Payload
) => {
  try {
    // get file from URL
    const response = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
    });

    const buffer = Buffer.from(response.data, 'binary');

    // Upload file to S3
    const uploadParams = {
      Bucket: inputBucketName,
      Key: fileKey,
      Body: buffer,
      ACL: 'public-read' as const,
      ContentType: response.headers['content-type'],
      Metadata: {
        outputbucket: streamBucketName,
        webhookurl: `${process.env.NEXT_PUBLIC_SERVER_URL}/api/update-video-status?token=${process.env.WEBHOOK_TOKEN}`,
        clientid: workspaceSlug,
        clientenv: `${process.env.AWS_MEDIACONVERT_CLIENT_ENV}`,
      },
    };
    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
    });
    const data = await upload.done();
    return data.Location;
  } catch (error) {
    payload.logger.error({
      msg: ':: VIMEO IMPORT :: Failed to upload video to S3',
      error: error,
    });
    return false;
  }
};

const fetchAndUpdateVimeoThumbnail = async (
  vimeoId: string,
  vimeoToken: string,
  video: Video,
  req: PayloadRequest
) => {
  const vimeoData = await getVimeoData(vimeoId, vimeoToken);
  if (!vimeoData) {
    throw new Error('Failed to fetch Vimeo video data');
  }
  if (vimeoData.pictures?.active && vimeoData.pictures?.type === 'custom') {
    const vimeoThumbnailUrl = vimeoData.pictures.base_link;

    try {
      // get image file from vimeo URL
      const response = await axios.get(vimeoThumbnailUrl, {
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data, 'binary');

      // prepare image for upload to ignite API
      // image from vimeo may be from different mime type, so we need to convert it to jpeg
      const image = await encodeImageFile(buffer, 1080, 80);

      const blob = new Blob([image], { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', blob, 'thumbnail.jpg');

      const apiUrl = `${process.env.NEXT_PUBLIC_SERVER_URL}/api/videos/${video.id}/thumbnail`;

      const BearerTokenFromRequest = req.headers.get('Authorization');
      if (!BearerTokenFromRequest) {
        throw new Error('No Bearer token found in request headers');
      }

      const uploadResponse = await fetch(apiUrl, {
        method: 'PUT',
        headers: { Authorization: BearerTokenFromRequest },
        body: formData,
      });
      if (!uploadResponse.ok) {
        const err = await uploadResponse.text().catch(() => '');
        throw new Error(err || 'Failed to upload thumbnail');
      }
      const uploadResult = await uploadResponse.json();
      return uploadResult;
    } catch (error) {
      req.payload.logger.error({
        msg: ':: VIMEO IMPORT :: General thumbnail error',
        error: error,
      });
      throw new Error('Failed to download thumbnail');
    }
  } else {
    throw new Error('Vimeo video has no custom thumbnail');
  }
};
