-- Migration to add Gender and Date of Birth fields to public.profiles table

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS gender TEXT,
ADD COLUMN IF NOT EXISTS date_of_birth DATE;
