// lib/validation.ts  — BEZ 'use server'!
import { z } from 'zod';

export const usernameSchema = z
  .string()
  .min(3, 'Aspoň 3 znaky.')                                   // limit zdola
  .max(20, 'Max. 20 znakov.')                                  // limit zhora
  .regex(/^[a-z0-9_]+$/, 'Len malé písmená, čísla a podčiarkovník.')  // 0-9 je tu
  .regex(/^[a-z]/, 'Musí začínať písmenom.');
// keby si chcel prísny username štýl:
// .regex(/^[a-z0-9_]+$/, 'Len malé písmená, čísla a podčiarkovník.')

export const emailSchema = z.string().email('Neplatný formát emailu.');

export const passwordSchema = z
  .string()
  .min(8, 'Aspoň 8 znakov.')
  .regex(/[A-Z]/, 'Aspoň jedno veľké písmeno.')
  .regex(/[0-9]/, 'Aspoň jedno číslo.');

export const SignupSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});