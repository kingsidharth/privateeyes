import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'node:fs';
import { config } from './config.js';
export const client = new S3Client({ region:'auto', endpoint:`https://${config.r2AccountId}.r2.cloudflarestorage.com`, forcePathStyle:true, credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey} });
export async function putFile(path: string, key: string, mime: string, disposition: string) { await new Upload({client,params:{Bucket:config.bucket,Key:key,Body:fs.createReadStream(path),ContentType:mime,ContentDisposition:disposition}}).done(); }
export async function deleteFile(key: string) { await client.send(new DeleteObjectCommand({Bucket:config.bucket,Key:key})); }
