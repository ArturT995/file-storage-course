import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import { type BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";
import path from "path";
import { rm } from "fs/promises";



export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const videoId = (req.params as { videoId?: string }).videoId;
  if (!videoId) throw new BadRequestError("Invalid video ID");
  
  const token = getBearerToken(req.headers)
  const userID = validateJWT(token, cfg.jwtSecret)
  console.log("uploading video", videoId, "by user", userID);

  const data = await req.formData()
  const video = data.get("video")
  const MAX_UPLOAD_SIZE = 1 << 30;
  if (!(video instanceof File)) throw new BadRequestError("Video file missing");
  if (video.size > MAX_UPLOAD_SIZE) throw new BadRequestError("Video too large, max size: 1GB");
  

  const mediaType = video.type
  const videoType = "video/mp4"
  if (!mediaType) throw new BadRequestError("Missing Content-Type for video");
  if (mediaType !== videoType) throw new BadRequestError("Invalid Content-Type for video, only MP4 is allowed");

  const videoTemp = getVideo(cfg.db, videoId);
  if (!videoTemp) throw new NotFoundError("Couldn't find video");
  if (videoTemp.userID !== userID) throw new UserForbiddenError("Not authorized to update this video");
  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);
  const arrayBuffer = await video.arrayBuffer();
  const videoBytes = Buffer.from(arrayBuffer);

  
  //writing, setting url and func calls
  await Bun.write(tempFilePath, videoBytes)
  const aspectRatio = await getVideoAspectRatio(tempFilePath)
  let key = `${aspectRatio}/${videoId}.mp4`;
  const url = `${key}`
  videoTemp.videoURL = url;
  const processedVid = await processVideoForFastStart(tempFilePath)
  

  //S3
  const body = Bun.file(processedVid)
  if (!await body.exists()) {
  throw new Error("Processed file was not created");
  }
  const s3file = cfg.s3Client.file(key, { bucket: cfg.s3Bucket });
  await s3file.write(body, { type: videoType });
  

  //Sign and update
  const videoData = await dbVideoToSignedVideo(cfg, videoTemp)
  updateVideo(cfg.db, videoData);


  await Promise.all([rm(tempFilePath, { force: true })]);
  return respondWithJSON(200, videoData);
}







//Helpers

async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  return cfg.s3Client.presign(key, { expiresIn: expireTime });
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  video.videoURL = await generatePresignedURL(cfg, video.videoURL!, 360)
  return video;
}


async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn({
  cmd: ["ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height", "-of", "json", filePath],
  stdout: "pipe",
  stderr: "pipe",
});

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  if (await proc.exited !== 0) {
    throw new Error(stderrText);
  }

  const data = JSON.parse(stdoutText)
  const { width, height } = data.streams[0];
  const landscape = Math.floor((16 / 9) * 100)
  const portrait = Math.floor((9 / 16) * 100)
  const aspect = Math.floor((width / height) * 100);
  
  let ratio = "other"
  if (aspect === landscape) {
    ratio = "landscape"
  }
  else if (aspect === portrait) {
    ratio = "portrait"
  }

  return ratio;
}


async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = inputFilePath + ".processed"
  const proc = Bun.spawn({
  cmd: ["ffmpeg", "-i", inputFilePath, "-movflags", "faststart",
        "-map_metadata","0", "-codec", "copy", "-f", "mp4", outputFilePath],
  stdout: "pipe",
  stderr: "pipe",
  });
  await new Response(proc.stdout).text();
  
  const errorText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with code ${exitCode}: ${errorText}`);
  }
  return outputFilePath
}