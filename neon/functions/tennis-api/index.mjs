import postgres from 'postgres';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetBucketAclCommand, GetBucketPolicyCommand } from '@aws-sdk/client-s3';
import worker from '../../../dist/node/worker.mjs';
import { createNeonFunction } from './runtime.mjs';

// Neon Functions inject the branch's database and private S3 credentials.
// The public GitHub frontend receives only this function's origin.
export default createNeonFunction({ worker, postgres, S3Client,
  commands: { PutObjectCommand, GetObjectCommand, DeleteObjectCommand, GetBucketAclCommand, GetBucketPolicyCommand } });
