import { z } from "zod";

export const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address")
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const hexString = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "must be 0x-prefixed hex")
  .transform((v) => v as `0x${string}`);

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const tokenParam = z.object({ tokenId: z.coerce.number().int().positive() });

export const pagination = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().min(0).optional(),
};

export const errorBody = z.object({
  error: z.object({ code: z.string(), message: z.string() }).loose(),
});

export const bearer = [{ bearerAuth: [] }];
