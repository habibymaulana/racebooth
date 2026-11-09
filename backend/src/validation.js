import { z } from 'zod';
export const uuid = z.string().uuid();
export const loginSchema = z.object({ email: z.string().email().trim().toLowerCase().max(254), password: z.string().min(1).max(1024) }).strict();
const fields = {
  name: z.string().trim().min(2).max(100), price_idr: z.number().int().min(0).max(1000000000),
  photo_limit: z.number().int().min(1).max(1000), session_duration_minutes: z.number().int().min(1).max(1440),
  is_active: z.boolean()
};
export const packageSchema = z.object({ ...fields, is_active: fields.is_active.default(true) }).strict();
export const packagePatchSchema = z.object(fields).partial().strict().refine(o => Object.keys(o).length > 0, 'At least one field is required.');
export const transactionSchema = z.object({ packageId: uuid, idempotencyKey: uuid }).strict();
export const confirmationSchema = z.object({ confirmation: z.literal('SIMULATED_PAYMENT') }).strict();

export const publicTransactionSchema = z.object({
  packageId: uuid,
  idempotencyKey: z.string().uuid().optional()
}).strict();

export const simulatePaymentSchema = z.object({
  scenario: z.enum(['success', 'failure', 'expired', 'cancelled']).default('success'),
  checkoutKey: z.string().min(16).max(128)
}).strict();

export const paymentWebhookSchema = z.object({
  transaction_id: uuid,
  event: z.string().min(1).max(100),
  status: z.enum(['paid', 'failed', 'cancelled']),
  scenario: z.string().max(50).optional(),
  failure_reason: z.string().max(100).nullable().optional(),
  simulated_at: z.string().optional()
}).passthrough();

export const photoUploadSchema = z.object({
  sequence: z.number().int().min(1).max(1000),
  filter: z.enum([
    'original','bw','vintage','warm','cool','sepia','contrast','glow',
    'pencil-sketch','comic-pop','doodle-art','retro-print','dreamy-illustration','magazine-cutout'
  ]).default('original'),
  checkoutKey: z.string().min(16).max(256),
}).strict();

export const photostripSchema = z.object({
  background: z.enum([
    'white','black','pink','yellow','mint','lavender',
    'blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories',
    'doodle-booth','retro-checker','denim-memories','polka-party','heart-collage','vintage-film'
  ]).optional(),
  filter: z.enum([
    'original','bw','vintage','warm','cool','sepia','contrast','glow',
    'pencil-sketch','comic-pop','doodle-art','retro-print','dreamy-illustration','magazine-cutout'
  ]).default('original'),
  finalize: z.boolean().default(false),
  editRevision: z.number().int().min(0).max(1000000).default(0),
  checkoutKey: z.string().min(16).max(256),
}).strict();

export const freeSessionSchema = z.object({
  frameDesign: z.enum([
    'blueberry','pink-diary','retro-bloom','midnight-film','sunny-picnic','sweet-memories',
    'doodle-booth','retro-checker','denim-memories','polka-party','heart-collage','vintage-film'
  ]).default('blueberry'),
});

export const emailDeliverySchema = z.object({
  recipientEmail: z.string().email().min(5).max(254),
  sessionKey: z.string().optional(),
});
