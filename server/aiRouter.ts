import fs from 'fs';
import path from 'path';
import { isClaudeConfigured, generateClaudeClipAnalysis, generateClaudeLiveMetadata, generateClaudeChatEngagement } from './claude.ts';
import { isGeminiConfigured } from './gemini.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const AI_SETTINGS_FILE = path.join(DATA_DIR, 'ai_settings.json');

export type AiProviderChoice = 'claude' | 'gemini' | 'auto';

interface AiSettings {
  provider: AiProviderChoice;
}

let aiSettings: AiSettings = { provider: 'auto' };

export function initAiSettings() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(AI_SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf-8')) as Partial<AiSettings>;
      if (parsed.provider === 'claude' || parsed.provider === 'gemini' || parsed.provider === 'auto') {
        aiSettings.provider = parsed.provider;
      }
    }
  } catch {
    aiSettings = { provider: 'auto' };
  }
}

export function getAiSettings(): AiSettings {
  return aiSettings;
}

export function updateAiSettings(patch: Partial<AiSettings>): AiSettings {
  if (patch.provider === 'claude' || patch.provider === 'gemini' || patch.provider === 'auto') {
    aiSettings.provider = patch.provider;
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(AI_SETTINGS_FILE, JSON.stringify(aiSettings, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed to save AI settings:', err);
    }
  }
  return aiSettings;
}

export function getActiveAiProvider(): 'claude' | 'gemini' {
  const provider = aiSettings.provider;
  if (provider === 'claude') return 'claude';
  if (provider === 'gemini') return 'gemini';
  // Auto: prefer Claude if configured, else Gemini
  return isClaudeConfigured() ? 'claude' : 'gemini';
}
