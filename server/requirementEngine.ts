import type {
  ClipFormatMode,
  ContentLanguageChoice,
  IdeaLanguagePreference,
  MomentCategory,
  RequirementSpec,
  VideoAspectMode,
} from '../src/types.ts';

export interface ParsedRequirementContext {
  spec: RequirementSpec;
  topicKeywords: string[];
  requiredNicheGroups: Array<{ label: string; patterns: string[] }>;
  isGtaContext: boolean;
  hasExplicitTimeRange: boolean;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'for',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'this',
  'that',
  'video',
  'videos',
  'clip',
  'clips',
  'short',
  'shorts',
  'moment',
  'moments',
  'best',
  'top',
  'new',
  'make',
  'find',
  'pick',
  'only',
  'full',
  'highlights',
  'highlight',
  'stream',
  'live',
  'bd',
  'bangla',
  'bengali',
  'banglish',
  'english',
]);

const NICHE_SYNONYMS: Record<string, string[]> = {
  gta: ['gta', 'gta 6', 'gta6', 'gta vi', 'gtavi', 'gta 5', 'gta v', 'gtav', 'grand theft auto', 'gta6hub', 'roleplay', 'gta rp'],
  'free fire': ['free fire', 'freefire', 'garena free fire', 'ff ', 'ff max', 'booyah', 'one tap', 'headshot'],
  gaming: ['gaming', 'game', 'gamer', 'gameplay', 'playthrough', 'montage', 'clutch', 'esports'],
  pubg: ['pubg', 'bgmi', 'playerunknown'],
  valorant: ['valorant', 'val ', 'radiant', 'ace'],
  minecraft: ['minecraft', 'mcpe', 'smp', 'survival'],
  comedy: ['comedy', 'funny', 'humor', 'roast', 'prank', 'laugh', 'troll', 'meme', 'hasir', 'funniest'],
  funny: ['funny', 'comedy', 'hilarious', 'laugh', 'fail', 'fails', 'troll', 'rage', 'meme', 'hasir'],
  viral: ['viral', 'insane', 'crazy', 'shocking', 'unbelievable', 'epic', 'clutch', 'omg'],
  adventure: ['adventure', 'explore', 'exploration', 'quest', 'survival', 'story', 'journey', 'open world', 'map'],
};

const URL_TOKEN_STOPWORDS = new Set([
  'http',
  'https',
  'www',
  'com',
  'net',
  'org',
  'io',
  'youtu',
  'youtube',
  'watch',
  'live',
  'feature',
  'share',
  'si',
  'list',
  'index',
  'tiktok',
  'reels',
]);

const DUMMY_HASHTAG_RE =
  /^#?(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|(?:hashtag|hash\s*tag|tag|clip|part|video|short|number|num)[_-]?(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)|fyp\d*|foryou(?:page)?|test\d*|placeholder|dummy|none|null|undefined|http|https|www|youtube|youtu|watch|com)$/i;

const GTA_ONLY_TAG_RE = /^#?(?:gta6hub|gtavi|gta6|gta_?6|gta_?vi|gtav|gta5|grandtheftauto)$/i;

const DUMMY_TEXT_PHRASE_RE =
  /#?\b(?:hashtag|hash\s*tag|tag|number|clip|part)\s*[-_:]?\s*(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/gi;

const STANDALONE_DUMMY_HASH_RE =
  /(?:^|\s)#(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+|https?|www|youtu(?:be)?)\b/gi;

export function stripUrlsFromText(text?: string): string {
  if (!text) return '';
  return String(text)
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/\bwww\.[^\s]+/gi, ' ')
    .replace(/\byoutu\.be\/[^\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isLikelyUrl(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return /^(?:https?:\/\/|www\.|youtu\.be\/|youtube\.com\/)/i.test(trimmed);
}

export function containsDummyOrNumberedTags(text?: string): boolean {
  if (!text) return false;
  const str = String(text);
  return (
    /#?\b(?:hashtag|hash\s*tag)\s*[-_:]?\s*(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/i.test(str) ||
    /(?:^|\s)#\d+\b/.test(str) ||
    /(?:^|\s)#(?:zero|one|two|three|four|five)\b/i.test(str)
  );
}

export function stripDummyPhrasesFromText(text?: string): string {
  if (!text) return '';
  return stripUrlsFromText(text)
    .replace(DUMMY_TEXT_PHRASE_RE, ' ')
    .replace(STANDALONE_DUMMY_HASH_RE, ' ')
    .replace(/(^|\s)#+(?=\s|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isGenericOrRepetitiveTitle(rawTitle?: string): boolean {
  const title = stripDummyPhrasesFromText(rawTitle || '')
    .replace(/#(?:bd|shorts?|viral|gaming|youtube)\b/gi, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!title || title.length < 8) return true;
  if (containsDummyOrNumberedTags(rawTitle)) return true;
  if (isLikelyUrl(rawTitle)) return true;

  const genericPatterns: RegExp[] = [
    /^(?:gta\s*(?:6|vi|5|v)?\s*)?(?:clutch|action|epic|insane|viral|best|top|full)?\s*(?:action\s*)?(?:clutch\s*)?(?:moment|highlight|clip|short|video|gameplay|play)s?$/i,
    /^(?:free\s*fire|pubg|valorant|minecraft|gaming|gameplay)\s+(?:clutch|action|highlight|viral|epic|funny)\s+(?:moment|clip|short|highlight)s?$/i,
    /^(?:untitled|test|placeholder|clip|segment|highlight|none|null)$/i,
  ];
  return genericPatterns.some((re) => re.test(title));
}

export function normalizeTitleWords(title?: string): string[] {
  return stripDummyPhrasesFromText(title || '')
    .toLowerCase()
    .replace(/#[^\s]+/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !URL_TOKEN_STOPWORDS.has(w));
}

export function areTitlesSimilar(titleA?: string, titleB?: string): boolean {
  const cleanA = stripDummyPhrasesFromText(titleA || '').toLowerCase().trim();
  const cleanB = stripDummyPhrasesFromText(titleB || '').toLowerCase().trim();
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;

  const wordsA = normalizeTitleWords(cleanA);
  const wordsB = normalizeTitleWords(cleanB);
  if (wordsA.length === 0 || wordsB.length === 0) {
    return cleanA.slice(0, 24) === cleanB.slice(0, 24);
  }
  if (wordsA.join(' ') === wordsB.join(' ')) return true;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let overlap = 0;
  for (const w of setA) {
    if (setB.has(w)) overlap += 1;
  }
  const unionSize = new Set([...wordsA, ...wordsB]).size;
  const jaccard = unionSize > 0 ? overlap / unionSize : 0;
  const minRatio = overlap / Math.max(1, Math.min(setA.size, setB.size));
  return jaccard >= 0.55 || minRatio >= 0.7;
}

export function detectIsGtaContext(text: string, categories: string[]): boolean {
  const combined = `${text} ${categories.join(' ')}`.toLowerCase();
  if (/(?:gta|grand theft auto|gtavi|gta6|gta 6|gta vi|gta 5|gta v|gta6hub)/i.test(combined)) {
    return true;
  }
  const hasNonGtaSpecific = categories.some((c) => {
    const lc = c.trim().toLowerCase();
    return Boolean(lc && lc !== 'other' && lc !== 'gta' && lc !== 'funny' && lc !== 'comedy' && lc !== 'viral');
  });
  if (hasNonGtaSpecific) return false;
  if (text.trim().length > 0 && !/(?:gta|grand theft auto)/i.test(combined)) {
    // User provided an explicit non-GTA topic prompt (e.g. Valorant, PUBG, Minecraft, Football)
    return false;
  }
  return false;
}

export function extractClipCountFromText(text?: string): number | undefined {
  if (!text) return undefined;
  const match = text.match(/\b(\d{1,2})\s*(?:clips?|shorts?|videos?|moments?)\b/i);
  if (!match) return undefined;
  const count = Number(match[1]);
  if (!Number.isFinite(count) || count < 1 || count > 20) return undefined;
  return count;
}

export function extractLanguageFromText(text?: string): IdeaLanguagePreference | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  if (/\bbanglish\b/i.test(lower)) return 'banglish';
  if (/\b(?:only\s+)?(?:bangla|bengali)\b|বাংলা/i.test(text)) return 'bengali';
  if (/\b(?:only\s+)?english\b/i.test(lower)) return 'english';
  return undefined;
}

export function parseRequirementSpec(params: {
  topicIdea?: string;
  categories?: string[];
  languagePreference?: IdeaLanguagePreference;
  clipCount?: number;
  formatMode?: ClipFormatMode;
  aspectMode?: VideoAspectMode;
  additionalInstructions?: string;
  label?: string;
}): ParsedRequirementContext {
  const cleanCategories = (params.categories || [])
    .map((c) => c.trim())
    .filter((c) => Boolean(c) && c.toLowerCase() !== 'other')
    .slice(0, 8);

  const rawIdea = stripUrlsFromText(params.topicIdea || '');
  const rawInstructions = stripUrlsFromText(params.additionalInstructions || '');
  const cleanLabel = stripUrlsFromText(params.label || '');
  const combinedSource = [rawIdea, rawInstructions, cleanLabel].filter(Boolean).join(' ');

  const inferredLang =
    params.languagePreference && params.languagePreference !== 'auto'
      ? params.languagePreference
      : extractLanguageFromText(rawInstructions) ||
        extractLanguageFromText(rawIdea) ||
        params.languagePreference ||
        'auto';

  const explicitClipCount =
    typeof params.clipCount === 'number' && Number.isFinite(params.clipCount) && params.clipCount >= 1
      ? Math.min(20, Math.floor(params.clipCount))
      : extractClipCountFromText(rawInstructions) || extractClipCountFromText(rawIdea);

  const formatMode: ClipFormatMode = params.formatMode === 'long' ? 'long' : 'short';
  const aspectMode: VideoAspectMode =
    formatMode === 'long' && params.aspectMode === 'landscape' ? 'landscape' : 'portrait';

  const spec: RequirementSpec = {
    topicIdea: rawIdea || rawInstructions || cleanLabel,
    lockedCategories: cleanCategories,
    languagePreference: inferredLang,
    ...(explicitClipCount ? { clipCount: explicitClipCount } : {}),
    formatMode,
    aspectMode,
    requiredTags: ['#BD'],
  };

  // Extract meaningful topic keywords (ignoring generic filler words and URL fragments)
  const tokenCandidates = (spec.topicIdea || '')
    .toLowerCase()
    .split(/[\s,.;:!?/\\|()[\]{}"']+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 2 &&
        !STOPWORDS.has(t) &&
        !URL_TOKEN_STOPWORDS.has(t) &&
        !/^[a-z0-9_-]{9,}$/i.test(t)
    );

  const topicKeywords = Array.from(new Set(tokenCandidates)).slice(0, 12);

  // Build hard niche groups for explicit game/niche categories (and any custom category)
  const requiredNicheGroups: Array<{ label: string; patterns: string[] }> = [];
  for (const cat of cleanCategories) {
    const lowerCat = cat.toLowerCase();
    const synonyms = NICHE_SYNONYMS[lowerCat];
    if (synonyms) {
      requiredNicheGroups.push({ label: cat, patterns: synonyms });
    } else {
      requiredNicheGroups.push({
        label: cat,
        patterns: [lowerCat, ...lowerCat.split(/\s+/).filter((w) => w.length >= 3)],
      });
    }
  }

  const isGtaContext = detectIsGtaContext(combinedSource, cleanCategories);
  const hasExplicitTimeRange = /(\d{1,2}(?::\d{2}){1,2})\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2}){1,2})/i.test(
    params.additionalInstructions || ''
  );

  return {
    spec,
    topicKeywords,
    requiredNicheGroups,
    isGtaContext,
    hasExplicitTimeRange,
  };
}

export function formatRequirementSummary(ctx: ParsedRequirementContext): string {
  const parts: string[] = [];
  if (ctx.spec.topicIdea) parts.push(`Topic: "${ctx.spec.topicIdea.slice(0, 80)}"`);
  if (ctx.spec.lockedCategories.length > 0) {
    parts.push(`Niches: [${ctx.spec.lockedCategories.join(', ')}]`);
  }
  parts.push(`Language: ${ctx.spec.languagePreference}`);
  if (ctx.spec.clipCount) parts.push(`Max Clips: ${ctx.spec.clipCount}`);
  parts.push(`Required Tag: #BD`);
  return parts.join(' · ');
}

export interface CandidateMatchResult {
  passed: boolean;
  reason?: string;
  matchedTokens: string[];
  matchedNiches: string[];
}

export function checkStrictCandidateMatch(
  candidate: {
    title: string;
    description: string;
    tags?: string[];
    channelTitle: string;
    defaultAudioLanguage?: string;
    matchedQuery?: string;
  },
  ctx: ParsedRequirementContext
): CandidateMatchResult {
  const haystack = `${candidate.title} ${candidate.description.slice(0, 500)} ${(candidate.tags || []).join(' ')} ${candidate.channelTitle}`.toLowerCase();

  // 1. Strict Game / Subject Niche Lock Check:
  // Any explicitly selected specific niche (especially distinct games like GTA, Free Fire, custom topic) must match,
  // and if the user typed a distinct game in the idea (e.g. "Valorant", "Minecraft", "PUBG"), ensure no drift.
  const matchedNiches: string[] = [];
  const primaryGameNiches = ctx.requiredNicheGroups.filter((g) => {
    const l = g.label.toLowerCase();
    return l !== 'viral' && l !== 'funny' && l !== 'comedy' && l !== 'adventure';
  });

  for (const niche of primaryGameNiches) {
    const hit = niche.patterns.some((pat) => haystack.includes(pat.toLowerCase()));
    if (!hit) {
      return {
        passed: false,
        reason: `Failed strict niche lock ("${niche.label}" not present in candidate metadata).`,
        matchedTokens: [],
        matchedNiches,
      };
    }
    matchedNiches.push(niche.label);
  }

  // Secondary mood/style niches (e.g. Comedy, Funny, Adventure) — check if at least one selected style or core topic hits
  const styleNiches = ctx.requiredNicheGroups.filter((g) => {
    const l = g.label.toLowerCase();
    return l === 'funny' || l === 'comedy' || l === 'adventure';
  });
  for (const niche of styleNiches) {
    if (niche.patterns.some((pat) => haystack.includes(pat.toLowerCase()))) {
      matchedNiches.push(niche.label);
    }
  }

  // 2. Strict Topic Keyword Alignment Check
  const matchedTokens = ctx.topicKeywords.filter((tok) => haystack.includes(tok));
  if (ctx.topicKeywords.length > 0) {
    const minRequiredHits = ctx.topicKeywords.length >= 3 ? 1 : 1;
    if (matchedTokens.length < minRequiredHits && matchedNiches.length === 0) {
      return {
        passed: false,
        reason: `Failed strict topic alignment (0 core topic keywords matched from "${ctx.spec.topicIdea}").`,
        matchedTokens,
        matchedNiches,
      };
    }

    // Check against contradictory game drift if candidate explicitly belongs to a conflicting major game
    const conflictingGames: Array<{ name: string; re: RegExp; allowedRe: RegExp }> = [
      {
        name: 'GTA',
        re: /\b(?:gta\s*[56v]|gta\s*vi|gtavi|gtav|grand theft auto)\b/i,
        allowedRe: /\b(?:gta|grand theft auto|gtavi|gtav|rockstar)\b/i,
      },
      {
        name: 'Free Fire',
        re: /\b(?:free\s*fire|freefire|garena\s*ff)\b/i,
        allowedRe: /\b(?:free\s*fire|freefire|ff|garena)\b/i,
      },
      {
        name: 'PUBG',
        re: /\b(?:pubg|bgmi)\b/i,
        allowedRe: /\b(?:pubg|bgmi)\b/i,
      },
      {
        name: 'Minecraft',
        re: /\b(?:minecraft)\b/i,
        allowedRe: /\b(?:minecraft)\b/i,
      },
      {
        name: 'Valorant',
        re: /\b(?:valorant)\b/i,
        allowedRe: /\b(?:valorant)\b/i,
      },
    ];

    const requirementText = `${ctx.spec.topicIdea} ${ctx.spec.lockedCategories.join(' ')}`;
    for (const game of conflictingGames) {
      const userMentionedGame = game.allowedRe.test(requirementText);
      const candidateIsGame = game.re.test(haystack);
      // If user explicitly locked another game (e.g. Free Fire) and candidate is GTA (or vice versa), reject drift
      if (!userMentionedGame && candidateIsGame && primaryGameNiches.length > 0) {
        return {
          passed: false,
          reason: `Rejected off-niche ${game.name} video while user locked [${ctx.spec.lockedCategories.join(', ')}].`,
          matchedTokens,
          matchedNiches,
        };
      }
    }
  }

  // 3. Strict Language Lock Check
  const hasBengaliScript = /[\u0980-\u09FF]/.test(
    `${candidate.title} ${candidate.description}`
  );
  const hasBanglaCue =
    hasBengaliScript ||
    /\b(?:bangla|bengali|bangladesh|bd|desi|dhaka|kolkata|bangladeshi)\b/i.test(haystack) ||
    Boolean(candidate.defaultAudioLanguage?.toLowerCase().startsWith('bn'));

  const langPref = ctx.spec.languagePreference;
  if (langPref === 'bengali') {
    if (!hasBengaliScript && !hasBanglaCue) {
      return {
        passed: false,
        reason: 'Failed strict Bangla language lock (no Bengali script or Bangla/BD indicator found).',
        matchedTokens,
        matchedNiches,
      };
    }
  } else if (langPref === 'banglish') {
    if (!hasBanglaCue) {
      return {
        passed: false,
        reason: 'Failed strict Banglish/Bangla audience lock (no Bangla/BD indicator found).',
        matchedTokens,
        matchedNiches,
      };
    }
  } else if (langPref === 'english') {
    const nonLatinLetters = (candidate.title.match(/[\u0980-\u09FF\u0600-\u06FF\u0400-\u04FF\u0900-\u097F]/g) || []).length;
    const latinWords = (candidate.title.match(/[a-zA-Z]{3,}/g) || []).length;
    const audioLang = (candidate.defaultAudioLanguage || '').toLowerCase();
    if (
      (audioLang && !audioLang.startsWith('en') && latinWords < 2) ||
      (nonLatinLetters > 4 && latinWords < 2)
    ) {
      return {
        passed: false,
        reason: 'Failed strict English language lock.',
        matchedTokens,
        matchedNiches,
      };
    }
  }

  // Reject Shorts compilation spam or off-niche music lyrics if topic isn't music
  if (
    /\b(?:official\s+music\s+video|full\s+song|lyrical\s+video)\b/i.test(candidate.title) &&
    !/\b(?:song|music|rap)\b/i.test(ctx.spec.topicIdea)
  ) {
    return {
      passed: false,
      reason: 'Rejected unrelated music video result.',
      matchedTokens,
      matchedNiches,
    };
  }

  return {
    passed: true,
    matchedTokens,
    matchedNiches,
  };
}

export function normalizeHashtagToken(raw: string): string | null {
  let clean = String(raw || '').trim();
  if (!clean) return null;
  if (DUMMY_TEXT_PHRASE_RE.test(clean)) {
    DUMMY_TEXT_PHRASE_RE.lastIndex = 0;
    return null;
  }
  DUMMY_TEXT_PHRASE_RE.lastIndex = 0;
  clean = clean.replace(/^#+/, '').replace(/[^\p{L}\p{M}\p{N}_]/gu, '');
  if (!clean || clean.length < 2) return null;
  if (
    DUMMY_HASHTAG_RE.test(clean) ||
    DUMMY_HASHTAG_RE.test(`#${clean}`) ||
    /^(?:hashtag|tag|clip|part|number)(?:zero|one|two|three|four|five|\d+)/i.test(clean)
  ) {
    return null;
  }
  return `#${clean}`;
}

export function sanitizeHashtags(
  rawHashtags: string[] | undefined,
  options?: {
    isGtaContext?: boolean;
    formatMode?: ClipFormatMode;
    lockedCategories?: string[];
    topicKeywords?: string[];
    momentCategory?: MomentCategory;
    sceneText?: string;
    minRelevant?: number;
    maxRelevant?: number;
  }
): string[] {
  const isGta = options?.isGtaContext ?? false;
  const formatMode = options?.formatMode ?? 'short';
  const minRelevant = Math.max(3, options?.minRelevant ?? 3);
  const maxRelevant = Math.min(5, Math.max(minRelevant, options?.maxRelevant ?? 5));

  const seenLower = new Set<string>(['#bd']);
  const relevantTags: string[] = [];

  for (const item of rawHashtags || []) {
    const normalized = normalizeHashtagToken(item);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    if (lower === '#bd') continue;
    if (formatMode === 'long' && (lower === '#shorts' || lower === '#youtubeshort' || lower === '#youtubeshorts')) {
      continue;
    }
    if (!isGta && GTA_ONLY_TAG_RE.test(normalized)) {
      continue;
    }
    if (seenLower.has(lower)) continue;
    seenLower.add(lower);
    relevantTags.push(normalized);
    if (relevantTags.length >= maxRelevant) break;
  }

  // Derive clean, relevant fallback tags from scene context, categories, and topic keywords
  if (relevantTags.length < minRelevant) {
    const derivedCandidates: string[] = [];

    // 1. Scene-specific concepts from moment summary / title / captions
    const sceneLower = (options?.sceneText || '').toLowerCase();
    const sceneConceptMap: Array<[RegExp, string]> = [
      [/\b(?:crash|wreck|accident|smash|collision)\b/i, '#EpicCrash'],
      [/\b(?:police|cop|wanted|chase|escape|siren)\b/i, '#PoliceChase'],
      [/\b(?:stunt|jump|flip|ramp|bike|car|drift)\b/i, '#CrazyStunt'],
      [/\b(?:npc|glitch|bug|ragdoll|physics)\b/i, '#FunnyNPC'],
      [/\b(?:headshot|onetap|one\s*tap|sniper|awm|deagle)\b/i, '#Headshot'],
      [/\b(?:squad|1v4|1v3|clutch|wipe|booyah|chicken\s*dinner)\b/i, '#ProPlay'],
      [/\b(?:boss|fight|duel|battle|roast|argument|twist)\b/i, '#PlotTwist'],
      [/\b(?:laugh|funny|comedy|meme|fail|rage|troll|panic)\b/i, '#FunnyMoments'],
      [/\b(?:reaction|shocked|omg|surprise|react)\b/i, '#LiveReaction'],
      [/\b(?:map|secret|hidden|location|easter\s*egg|detail)\b/i, '#HiddenDetail'],
    ];
    for (const [re, tag] of sceneConceptMap) {
      if (re.test(sceneLower)) {
        derivedCandidates.push(tag);
      }
    }

    for (const cat of options?.lockedCategories || []) {
      const slug = cat.replace(/[^a-zA-Z0-9]+/g, '');
      if (slug.length >= 2) derivedCandidates.push(`#${slug}`);
      if (/free\s*fire/i.test(cat)) derivedCandidates.push('#FreeFireBD', '#GamingBD');
      if (/gta/i.test(cat)) derivedCandidates.push('#GTA6', '#GTAVI', '#GamingBD');
      if (/comedy|funny/i.test(cat)) derivedCandidates.push('#FunnyMoments', '#BanglaGaming');
      if (/adventure/i.test(cat)) derivedCandidates.push('#OpenWorld', '#Gameplay');
    }

    for (const kw of options?.topicKeywords || []) {
      const slug = kw.replace(/[^a-zA-Z0-9]+/g, '');
      if (
        slug.length >= 3 &&
        !DUMMY_HASHTAG_RE.test(slug) &&
        !URL_TOKEN_STOPWORDS.has(slug.toLowerCase())
      ) {
        derivedCandidates.push(`#${slug.charAt(0).toUpperCase()}${slug.slice(1)}`);
      }
    }

    if (options?.momentCategory === 'funny') {
      derivedCandidates.push('#FunnyMoments', '#Comedy');
    } else if (options?.momentCategory === 'reaction') {
      derivedCandidates.push('#GamerReaction', '#GamingBD');
    } else if (options?.momentCategory === 'epic_gameplay') {
      derivedCandidates.push('#EpicGameplay', '#ProPlay');
    }

    if (isGta) {
      derivedCandidates.push('#GTA6', '#GTAVI', '#OpenWorld');
    }
    derivedCandidates.push('#GamingBD', '#BanglaGaming', '#Gameplay', '#Highlights');
    if (formatMode === 'short') {
      derivedCandidates.push('#Shorts');
    }

    for (const cand of derivedCandidates) {
      if (relevantTags.length >= minRelevant) break;
      const normalized = normalizeHashtagToken(cand);
      if (!normalized) continue;
      const lower = normalized.toLowerCase();
      if (seenLower.has(lower)) continue;
      if (formatMode === 'long' && lower === '#shorts') continue;
      if (!isGta && GTA_ONLY_TAG_RE.test(normalized)) continue;
      seenLower.add(lower);
      relevantTags.push(normalized);
    }
  }

  return ['#BD', ...relevantTags.slice(0, maxRelevant)];
}

export function sanitizeSeoTags(
  rawTags: string[] | undefined,
  options?: {
    isGtaContext?: boolean;
    formatMode?: ClipFormatMode;
    lockedCategories?: string[];
    topicKeywords?: string[];
  }
): string[] {
  const isGta = options?.isGtaContext ?? false;
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const raw of rawTags || []) {
    const clean = stripDummyPhrasesFromText(String(raw || '').replace(/^#+/, '')).trim();
    if (!clean || clean.length < 2) continue;
    if (DUMMY_HASHTAG_RE.test(clean) || URL_TOKEN_STOPWORDS.has(clean.toLowerCase())) continue;
    if (!isGta && GTA_ONLY_TAG_RE.test(clean)) continue;
    if (options?.formatMode === 'long' && /^shorts?$/i.test(clean)) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(clean);
  }

  const defaults = [
    'BD',
    ...(options?.lockedCategories || []),
    ...(options?.topicKeywords || []).slice(0, 4),
    ...(isGta ? ['GTA VI', 'GTA 6', 'Open World'] : ['Gaming BD', 'Gameplay']),
    'Highlights',
  ];

  for (const d of defaults) {
    if (cleaned.length >= 10) break;
    const clean = stripDummyPhrasesFromText(d.replace(/^#+/, '')).trim();
    if (!clean || clean.length < 2 || URL_TOKEN_STOPWORDS.has(clean.toLowerCase())) continue;
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      cleaned.push(clean);
    }
  }

  return cleaned.slice(0, 12);
}

export function sanitizeTitleText(
  rawTitle: string | undefined,
  options?: {
    fallbackSummary?: string;
    formatMode?: ClipFormatMode;
    languageChoice?: ContentLanguageChoice;
    isGtaContext?: boolean;
    topicHint?: string;
  }
): string {
  let title = stripDummyPhrasesFromText(String(rawTitle || ''))
    .replace(/\s+/g, ' ')
    .trim();

  // Strip numbered dummy templates ("Clip #1:", "#1 -", "Part 2:", "1. ", "#0", "#2")
  title = title
    .replace(/^(?:clip|part|short|video|segment|highlight)\s*#?\d+\s*[:|\-–—]?\s*/i, '')
    .replace(/^\d{1,2}\s*[.):\-–—]\s+/, '')
    .replace(/(?:^|\s)#\d+(?=\s|$)/g, ' ')
    .replace(/^(?:part|clip)\s+\d+\b[:\-]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (options?.formatMode === 'long') {
    title = title.replace(/#Shorts\b/gi, '').replace(/\s+/g, ' ').trim();
  }

  if (!options?.isGtaContext) {
    title = title
      .replace(/\s*\|\s*GTA6HUB\b/gi, '')
      .replace(/\bGTA6HUB\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Reject generic/template/URL placeholders and derive from the specific scene summary
  if (isGenericOrRepetitiveTitle(title)) {
    const cleanSummary = stripDummyPhrasesFromText(options?.fallbackSummary || '')
      .replace(/^(?:high-activity|auto-detected|peak)\s+/i, '')
      .replace(/\s+detected via.*$/i, '')
      .replace(/[.!?]+$/, '')
      .trim();
    const cleanHint = stripUrlsFromText(options?.topicHint || '');
    const base =
      cleanSummary && !isGenericOrRepetitiveTitle(cleanSummary)
        ? cleanSummary
        : cleanHint || 'Unexpected Twist Caught On Camera';
    title = base;
  }

  // Enforce strict max 80 character limit cleanly without cutting mid-word when possible
  if (title.length > 80) {
    const slice = title.slice(0, 80);
    const lastSpace = slice.lastIndexOf(' ');
    title = (lastSpace > 48 ? slice.slice(0, lastSpace) : slice).trim();
  }

  return title;
}

export function resolveLockedLanguageChoice(
  aiLang: ContentLanguageChoice | string | undefined,
  lockedPref: IdeaLanguagePreference
): ContentLanguageChoice {
  if (lockedPref === 'bengali') return 'bengali';
  if (lockedPref === 'banglish') return 'banglish';
  if (lockedPref === 'english') return 'english';
  const v = String(aiLang || '').toLowerCase().trim();
  if (v === 'bengali' || v === 'bangla' || v === 'bn') return 'bengali';
  if (v === 'banglish' || v === 'mixed') return 'banglish';
  if (v === 'english' || v === 'en') return 'english';
  return 'banglish';
}

export function checkStrictMomentMatch(
  moment: {
    title?: string;
    description?: string;
    viral_reason?: string;
    moment_summary?: string;
  },
  ctx: ParsedRequirementContext
): { passed: boolean; reason?: string } {
  if (ctx.hasExplicitTimeRange) {
    return { passed: true };
  }

  const text = `${moment.moment_summary || ''} ${moment.title || ''} ${moment.description || ''} ${moment.viral_reason || ''}`.trim();
  if (text.length < 10) {
    return { passed: false, reason: 'Moment metadata is too empty/generic.' };
  }

  // Prevent off-niche GTA hallucination when user explicitly locked a different game niche
  const primaryGameNiches = ctx.requiredNicheGroups.filter((g) => {
    const l = g.label.toLowerCase();
    return l !== 'viral' && l !== 'funny' && l !== 'comedy' && l !== 'adventure';
  });

  if (!ctx.isGtaContext && primaryGameNiches.length > 0) {
    if (/\b(?:gta\s*[56v]|gta\s*vi|gtavi|grand theft auto|vice city|leonida)\b/i.test(text)) {
      return {
        passed: false,
        reason: `Moment copy drifted into GTA while job locked [${primaryGameNiches.map((n) => n.label).join(', ')}].`,
      };
    }
  }

  return { passed: true };
}

export function validateAndCleanClipMetadata(params: {
  moment: {
    category: MomentCategory;
    moment_summary?: string;
    viral_reason?: string;
    title?: string;
    description?: string;
    hashtags?: string[];
    tags?: string[];
    language_choice?: ContentLanguageChoice | string;
  };
  ctx: ParsedRequirementContext;
  clipNumber: number;
}): {
  clipNumber: number;
  momentSummary: string;
  title: string;
  description: string;
  hashtags: string[];
  tags: string[];
  viralReason: string;
  languageChoice: ContentLanguageChoice;
} {
  const { moment, ctx, clipNumber } = params;
  const languageChoice = resolveLockedLanguageChoice(
    moment.language_choice,
    ctx.spec.languagePreference
  );

  const rawSummary = stripDummyPhrasesFromText(moment.moment_summary || moment.viral_reason || '')
    .replace(/\s+/g, ' ')
    .trim();
  const momentSummary = (
    rawSummary && !/^(?:placeholder|none|n\/a|test)$/i.test(rawSummary)
      ? rawSummary
      : `${stripDummyPhrasesFromText(moment.title) || 'Highlight action'} captured in clip.`
  ).slice(0, 140);

  const hashtags = sanitizeHashtags(moment.hashtags, {
    isGtaContext: ctx.isGtaContext,
    formatMode: ctx.spec.formatMode,
    lockedCategories: ctx.spec.lockedCategories,
    topicKeywords: ctx.topicKeywords,
    momentCategory: moment.category,
    sceneText: `${momentSummary} ${moment.title || ''} ${moment.description || ''}`,
    minRelevant: 3,
    maxRelevant: 5,
  });

  const title = sanitizeTitleText(moment.title, {
    fallbackSummary: momentSummary,
    formatMode: ctx.spec.formatMode,
    languageChoice,
    isGtaContext: ctx.isGtaContext,
    topicHint: ctx.spec.topicIdea,
  });

  const tags = sanitizeSeoTags(moment.tags, {
    isGtaContext: ctx.isGtaContext,
    formatMode: ctx.spec.formatMode,
    lockedCategories: ctx.spec.lockedCategories,
    topicKeywords: ctx.topicKeywords,
  });

  // Clean description: strip dummy numbered hashtags/phrases (#0, #1, #2, Hashtag Zero/One/Two) and off-niche GTA6HUB spam
  let desc = stripDummyPhrasesFromText(String(moment.description || ''));

  if (!ctx.isGtaContext) {
    desc = desc
      .replace(/#GTAVI\b|#GTA6HUB\b|#GTA6\b/gi, '')
      .replace(/\bcaptured on GTA6HUB\b/gi, '')
      .replace(/\bGTA6HUB\b/gi, '')
      .replace(/(^|\s)#+(?=\s|$)/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  if (!desc || desc.length < 12) {
    if (languageChoice === 'bengali') {
      desc = `${momentSummary} — শেষ পর্যন্ত না দেখলে মিস করবা!`;
    } else if (languageChoice === 'banglish') {
      desc = `${momentSummary} — bhai ei scene ta miss koro na!`;
    } else {
      desc = `${momentSummary} — watch until the final second!`;
    }
  }

  // Ensure #BD appears cleanly in caption/description
  if (!/#bd\b/i.test(desc)) {
    desc = `${desc}\n\n${hashtags.join(' ')}`;
  }

  return {
    clipNumber,
    momentSummary,
    title,
    description: desc.slice(0, 2000),
    hashtags,
    tags,
    viralReason: stripDummyPhrasesFromText(moment.viral_reason || momentSummary).slice(0, 300),
    languageChoice,
  };
}

export function formatStructuredClipSummary(params: {
  clipNumber: number;
  momentSummary: string;
  title: string;
  caption: string;
  hashtags: string[];
}): string {
  const cleanTags = sanitizeHashtags(params.hashtags, { minRelevant: 3, maxRelevant: 5 });
  return [
    `Clip #: ${params.clipNumber}`,
    `Moment Summary: ${params.momentSummary}`,
    `Title: ${params.title.slice(0, 80)}`,
    `Caption: ${params.caption}`,
    `Hashtags: ${cleanTags.join(' ')}`,
  ].join('\n');
}
