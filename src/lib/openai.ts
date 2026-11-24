import OpenAI from "openai";
import { env } from "./env.js";

export const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

export const CHUNKING_MODEL = "gpt-4.1";
