import path from "path"
import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { randomBytes } from "crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = videoThumbnails.get(videoId);
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail.data, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const data = await req.formData()

  const thumbnail = data.get("thumbnail");
  const MAX_UPLOAD_SIZE = 10 << 20;

  if (!(thumbnail instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }
  if (thumbnail.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail too large, max size: 10MB");
  }

  const mediaType = thumbnail.type
  if (!mediaType) throw new BadRequestError("Missing Content-Type for thumbnail");
  if (mediaType !== "image/jpeg" && mediaType !== "image/png" ) {
    throw new BadRequestError("Invalid Content-Type for thumbnail")
  };

  const arrayBuffer = await thumbnail.arrayBuffer();
  const imageBytes = Buffer.from(arrayBuffer);

  const randomName = randomBytes(32).toString("base64url");

  const filetype = "."+mediaType.split("/")[1]
  const urlPath = `/assets/${randomName}${filetype}`
  const fullPath = path.join(cfg.assetsRoot, `${randomName}${filetype}`)
  await Bun.write(fullPath, imageBytes)
  
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not authorized to update this video");
  }

  const port = cfg.port
  video.thumbnailURL = `http://localhost:${port}${urlPath}`
  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
