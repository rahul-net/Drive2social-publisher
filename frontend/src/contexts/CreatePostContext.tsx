// ============================================================
// CreatePostContext — state for the Create Post wizard (Phase 6).
//
// Owns the selected Drive video, the editable post metadata (either
// Gemini-generated or written manually), the generation inputs, and
// the wizard step. Everything persists to sessionStorage so a reload
// or back-navigation never loses work.
//
// Phase 7 (queue worker + wizard steps 5–7: destinations, review &
// enqueue, publishing status) reuses this context and the storage
// keys exported below — do not rename them.
//
// Phase 8: publish settings are SEEDED from GET /api/settings (the
// Settings page) — but only when there is NO in-progress draft in
// sessionStorage. Precedence, highest first:
//   1. sessionStorage draft (the wizard the user already started)
//   2. saved user settings from the server (Settings page defaults)
//   3. hardcoded DEFAULT_PUBLISH_SETTINGS below
// A later change on the Settings page never clobbers a draft the
// user already started; the seed is applied once per provider mount.
// ============================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Destination,
  DriveVideoFile,
  GeminiMetadataResult,
  MetadataAnalysisMode,
  PrivacyStatus,
} from "@shared";
import { loadSelectedDriveFile } from "../lib/driveSelection";
import { useAuth } from "./AuthContext";
import { loadUserSettings } from "../lib/settings";

/** Editable post metadata (shared shape for generated + manual). */
export interface EditedMetadata {
  youtube_title: string;
  youtube_description: string;
  youtube_tags: string[];
  facebook_caption: string;
  hashtags: string[];
}

export type MetadataSource = "generated" | "manual";

export interface MetadataProvenance {
  source: MetadataSource;
  /** Null for manually written metadata. */
  analysisMode: MetadataAnalysisMode | null;
  framesUsed: number;
  generatedAt: string; // ISO-8601
}

export interface GenerateInputs {
  topic: string;
  transcript: string;
  language: string;
}

// --- sessionStorage keys (Phase 7 reuses these; do not rename) ---
export const CREATE_POST_FILE_KEY = "drive2social:createPost:file";
export const CREATE_POST_METADATA_KEY = "drive2social:createPost:metadata";
export const CREATE_POST_PROVENANCE_KEY = "drive2social:createPost:provenance";
export const CREATE_POST_GENERATE_INPUTS_KEY =
  "drive2social:createPost:generateInputs";
export const CREATE_POST_STEP_KEY = "drive2social:createPost:step";
// Phase 7: destinations (step 5) + publish settings (step 6). New
// keys; the Phase-6 keys above are untouched (do not rename).
export const CREATE_POST_DESTINATIONS_KEY = "drive2social:createPost:destinations";
export const CREATE_POST_SETTINGS_KEY = "drive2social:createPost:settings";

/** All 7 wizard steps are live as of Phase 7. */
export const CREATE_POST_MAX_STEP = 7;

/** Step 6 state: per-publish settings (YouTube + Facebook). */
export interface PublishSettings {
  privacyStatus: PrivacyStatus;
  categoryId: string;
  madeForKids: boolean;
  notifySubscribers: boolean;
  /** Facebook Page id; "" means "use the account's selected Page". */
  pageId: string;
}

const DEFAULT_PUBLISH_SETTINGS: PublishSettings = {
  // "private" is the safe default: YouTube forces uploads from
  // unverified OAuth apps to private anyway, so the default never
  // promises more than the platform delivers.
  privacyStatus: "private",
  categoryId: "",
  madeForKids: false,
  notifySubscribers: true,
  pageId: "",
};

function isDestination(v: unknown): v is Destination {
  return v === "youtube" || v === "facebook";
}

function readDestinations(): Destination[] {
  const raw = readJson<unknown>(CREATE_POST_DESTINATIONS_KEY);
  if (!Array.isArray(raw)) return [];
  const deduped = [...new Set(raw.filter(isDestination))];
  // Keep wizard order: YouTube first, then Facebook.
  return deduped.sort((a, b) => (a === b ? 0 : a === "youtube" ? -1 : 1));
}

function readPublishSettings(): PublishSettings {
  const raw = readJson<Partial<PublishSettings>>(CREATE_POST_SETTINGS_KEY);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PUBLISH_SETTINGS };
  return {
    privacyStatus:
      raw.privacyStatus === "public" ||
      raw.privacyStatus === "unlisted" ||
      raw.privacyStatus === "private"
        ? raw.privacyStatus
        : DEFAULT_PUBLISH_SETTINGS.privacyStatus,
    categoryId:
      typeof raw.categoryId === "string" ? raw.categoryId : "",
    madeForKids: raw.madeForKids === true,
    notifySubscribers: raw.notifySubscribers !== false,
    pageId: typeof raw.pageId === "string" ? raw.pageId : "",
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable — state still works in memory.
  }
}

function removeKey(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function isDriveVideoFile(v: unknown): v is DriveVideoFile {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { name?: unknown }).name === "string"
  );
}

/** Seed the wizard from the Drive page's "Use in Create Post" handoff. */
function initialFile(): DriveVideoFile | null {
  const direct = readJson<unknown>(CREATE_POST_FILE_KEY);
  if (isDriveVideoFile(direct)) return direct;
  const handoff = loadSelectedDriveFile();
  return isDriveVideoFile(handoff) ? handoff : null;
}

const EMPTY_METADATA: EditedMetadata = {
  youtube_title: "",
  youtube_description: "",
  youtube_tags: [],
  facebook_caption: "",
  hashtags: [],
};

const DEFAULT_GENERATE_INPUTS: GenerateInputs = {
  topic: "",
  transcript: "",
  language: "en",
};

interface CreatePostContextValue {
  /** 1-based wizard step. */
  step: number;
  goToStep: (n: number) => void;
  /** Highest reachable step given current state (≤ CREATE_POST_MAX_STEP). */
  maxReachableStep: number;

  file: DriveVideoFile | null;
  /** Selecting a different video clears stale metadata. */
  selectFile: (file: DriveVideoFile | null) => void;

  /** Null until generated or written manually. */
  metadata: EditedMetadata | null;
  setMetadata: (metadata: EditedMetadata) => void;
  provenance: MetadataProvenance | null;
  applyGenerated: (result: GeminiMetadataResult) => void;
  startManual: () => void;
  clearMetadata: () => void;

  generateInputs: GenerateInputs;
  setGenerateInputs: (inputs: GenerateInputs) => void;

  /** Step 5: chosen destinations (YouTube / Facebook Page). */
  destinations: Destination[];
  setDestinations: (destinations: Destination[]) => void;

  /** Step 6: publish settings (privacy, category, kids, notify, page). */
  publishSettings: PublishSettings;
  setPublishSettings: (settings: PublishSettings) => void;

  resetAll: () => void;
}

const CreatePostContext = createContext<CreatePostContextValue | null>(null);

export function CreatePostProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [file, setFile] = useState<DriveVideoFile | null>(initialFile);
  const [metadata, setMetadataState] = useState<EditedMetadata | null>(() =>
    readJson<EditedMetadata>(CREATE_POST_METADATA_KEY),
  );
  const [provenance, setProvenanceState] = useState<MetadataProvenance | null>(
    () => readJson<MetadataProvenance>(CREATE_POST_PROVENANCE_KEY),
  );
  const [generateInputs, setGenerateInputsState] = useState<GenerateInputs>(
    () => readJson<GenerateInputs>(CREATE_POST_GENERATE_INPUTS_KEY) ?? DEFAULT_GENERATE_INPUTS,
  );
  const [step, setStepState] = useState<number>(() => {
    const saved = readJson<number>(CREATE_POST_STEP_KEY);
    return typeof saved === "number" && saved >= 1 && saved <= 7
      ? Math.floor(saved)
      : 1;
  });
  const [destinations, setDestinationsState] = useState<Destination[]>(readDestinations);
  const [publishSettings, setPublishSettingsState] =
    useState<PublishSettings>(readPublishSettings);
  // Phase 8: true when a settings draft already exists in
  // sessionStorage — the draft always wins over the server settings.
  const hasStoredDraftRef = useRef<boolean>(
    readJson<unknown>(CREATE_POST_SETTINGS_KEY) !== null,
  );
  const settingsSeededRef = useRef<boolean>(false);

  // Phase 8: seed publish settings from the user's saved defaults
  // (Settings page → GET /api/settings), but ONLY when there is no
  // in-progress draft in sessionStorage. Runs once per provider
  // mount, and only when signed in (the endpoint is 401 otherwise).
  useEffect(() => {
    if (settingsSeededRef.current || hasStoredDraftRef.current) return;
    if (!user) return;
    settingsSeededRef.current = true;
    loadUserSettings()
      .then((s) => {
        if (!s) return;
        const seeded: PublishSettings = {
          privacyStatus: s.defaultPrivacy,
          categoryId: s.defaultCategoryId,
          madeForKids: s.defaultMadeForKids,
          notifySubscribers: s.defaultNotifySubscribers,
          pageId: s.defaultPageId ?? "",
        };
        setPublishSettingsState(seeded);
        writeJson(CREATE_POST_SETTINGS_KEY, seeded);
      })
      .catch(() => {
        // Non-fatal: the wizard keeps its hardcoded defaults.
      });
  }, [user]);

  const maxReachableStep = useMemo(() => {
    if (!file) return 1;
    if (!metadata) return 3;
    // Steps 6 (settings) always has valid defaults, so choosing at
    // least one destination unlocks 6 and 7 together.
    if (destinations.length === 0) return 5;
    return CREATE_POST_MAX_STEP;
  }, [file, metadata, destinations]);

  const goToStep = useCallback(
    (n: number) => {
      const clamped = Math.max(1, Math.min(n, maxReachableStep));
      setStepState(clamped);
      writeJson(CREATE_POST_STEP_KEY, clamped);
    },
    [maxReachableStep],
  );

  const selectFile = useCallback(
    (next: DriveVideoFile | null) => {
      if (file?.id !== next?.id) {
        // Stale metadata belongs to the previous video.
        setMetadataState(null);
        setProvenanceState(null);
        removeKey(CREATE_POST_METADATA_KEY);
        removeKey(CREATE_POST_PROVENANCE_KEY);
        goToStep(1);
      }
      setFile(next);
      if (next) writeJson(CREATE_POST_FILE_KEY, next);
      else removeKey(CREATE_POST_FILE_KEY);
    },
    [file, goToStep],
  );

  const setMetadata = useCallback((next: EditedMetadata) => {
    setMetadataState(next);
    writeJson(CREATE_POST_METADATA_KEY, next);
  }, []);

  const applyGenerated = useCallback(
    (result: GeminiMetadataResult) => {
      const next: EditedMetadata = {
        youtube_title: result.youtube_title,
        youtube_description: result.youtube_description,
        youtube_tags: [...result.youtube_tags],
        facebook_caption: result.facebook_caption,
        hashtags: [...result.hashtags],
      };
      setMetadataState(next);
      writeJson(CREATE_POST_METADATA_KEY, next);
      const prov: MetadataProvenance = {
        source: "generated",
        analysisMode: result.analysisMode,
        framesUsed: result.framesUsed,
        generatedAt: new Date().toISOString(),
      };
      setProvenanceState(prov);
      writeJson(CREATE_POST_PROVENANCE_KEY, prov);
    },
    [],
  );

  const startManual = useCallback(() => {
    setMetadataState({ ...EMPTY_METADATA, youtube_tags: [], hashtags: [] });
    writeJson(CREATE_POST_METADATA_KEY, {
      ...EMPTY_METADATA,
      youtube_tags: [],
      hashtags: [],
    });
    const prov: MetadataProvenance = {
      source: "manual",
      analysisMode: null,
      framesUsed: 0,
      generatedAt: new Date().toISOString(),
    };
    setProvenanceState(prov);
    writeJson(CREATE_POST_PROVENANCE_KEY, prov);
  }, []);

  const clearMetadata = useCallback(() => {
    setMetadataState(null);
    setProvenanceState(null);
    removeKey(CREATE_POST_METADATA_KEY);
    removeKey(CREATE_POST_PROVENANCE_KEY);
  }, []);

  const setGenerateInputs = useCallback((inputs: GenerateInputs) => {
    setGenerateInputsState(inputs);
    writeJson(CREATE_POST_GENERATE_INPUTS_KEY, inputs);
  }, []);

  const setDestinations = useCallback((next: Destination[]) => {
    const deduped = [...new Set(next.filter(isDestination))].sort((a, b) =>
      a === b ? 0 : a === "youtube" ? -1 : 1,
    );
    setDestinationsState(deduped);
    writeJson(CREATE_POST_DESTINATIONS_KEY, deduped);
  }, []);

  const setPublishSettings = useCallback((next: PublishSettings) => {
    setPublishSettingsState(next);
    writeJson(CREATE_POST_SETTINGS_KEY, next);
  }, []);

  const resetAll = useCallback(() => {
    setFile(null);
    setMetadataState(null);
    setProvenanceState(null);
    setGenerateInputsState(DEFAULT_GENERATE_INPUTS);
    setDestinationsState([]);
    setPublishSettingsState({ ...DEFAULT_PUBLISH_SETTINGS });
    setStepState(1);
    for (const k of [
      CREATE_POST_FILE_KEY,
      CREATE_POST_METADATA_KEY,
      CREATE_POST_PROVENANCE_KEY,
      CREATE_POST_GENERATE_INPUTS_KEY,
      CREATE_POST_STEP_KEY,
      CREATE_POST_DESTINATIONS_KEY,
      CREATE_POST_SETTINGS_KEY,
    ]) {
      removeKey(k);
    }
  }, []);

  const value = useMemo<CreatePostContextValue>(
    () => ({
      step,
      goToStep,
      maxReachableStep,
      file,
      selectFile,
      metadata,
      setMetadata,
      provenance,
      applyGenerated,
      startManual,
      clearMetadata,
      generateInputs,
      setGenerateInputs,
      destinations,
      setDestinations,
      publishSettings,
      setPublishSettings,
      resetAll,
    }),
    [
      step,
      goToStep,
      maxReachableStep,
      file,
      selectFile,
      metadata,
      setMetadata,
      provenance,
      applyGenerated,
      startManual,
      clearMetadata,
      generateInputs,
      setGenerateInputs,
      destinations,
      setDestinations,
      publishSettings,
      setPublishSettings,
      resetAll,
    ],
  );

  return (
    <CreatePostContext.Provider value={value}>
      {children}
    </CreatePostContext.Provider>
  );
}

export function useCreatePost(): CreatePostContextValue {
  const ctx = useContext(CreatePostContext);
  if (!ctx) throw new Error("useCreatePost must be used inside CreatePostProvider");
  return ctx;
}
