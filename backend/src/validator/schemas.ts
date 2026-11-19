import {z} from 'zod';
export const configSchema=z.object({epochs:z.number().int().min(1).max(200),batch_size:z.number().int().min(16).max(256),learning_rate:z.number().min(.00001).max(.05),seed:z.number().int().min(0).max(999999),device:z.enum(['auto','cpu','cuda'])}).strict();
const metric=z.object({epoch:z.number().int().min(1).max(200),train_loss:z.number().nonnegative(),val_loss:z.number().nonnegative(),val_accuracy:z.number().min(0).max(1)});
export const progressSchema=z.object({
  epoch:z.number().int().min(0).max(200).default(0), history:z.array(metric).max(200).default([]),
  message:z.string().max(1200).default(''), elapsed_seconds:z.number().nonnegative().optional(),
  best_val_accuracy:z.number().min(0).max(1).optional(),test_accuracy:z.number().min(0).max(1).optional(),
  device:z.enum(['cpu','cuda']).optional(),device_name:z.string().max(200).optional(),
  gpu_peak_mb:z.number().nonnegative().nullable().optional(),
  split:z.object({train:z.number().int().nonnegative(),validation:z.number().int().nonnegative(),test:z.number().int().nonnegative()}).optional(),
  examples:z.array(z.object({pixels:z.array(z.number().min(0).max(16)).length(64),actual:z.number().int().min(0).max(9),predicted:z.number().int().min(0).max(9)})).max(12).optional()
}).strip();
export const heartbeatSchema=z.object({bird_audio_version:z.literal(1).optional(),cuda:z.boolean(),gpu:z.string().max(200).nullable(),vram_gb:z.number().nonnegative().nullable(),torch:z.string().max(100),python:z.string().max(100)}).strict();
