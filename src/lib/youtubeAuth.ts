import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  inMemoryPersistence,
  onAuthStateChanged,
  signInWithPopup,
  type Auth,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.force-ssl',
] as const;

let cachedAuth: Auth | null = null;

function getFirebaseAuth(): Auth | null {
  if (cachedAuth) return cachedAuth;
  try {
    const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    try {
      cachedAuth = initializeAuth(app, {
        persistence: inMemoryPersistence,
        popupRedirectResolver: browserPopupRedirectResolver,
      });
    } catch {
      cachedAuth = getAuth(app);
    }
    return cachedAuth;
  } catch (err) {
    console.warn('Firebase Auth initialization deferred/unavailable:', err);
    return null;
  }
}

function buildProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();
  for (const scope of YOUTUBE_SCOPES) {
    provider.addScope(scope);
  }
  provider.setCustomParameters({
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
  });
  return provider;
}

let isSigningIn = false;
let cachedAccessToken: string | null = null;

export function initYouTubeAuth(
  onSignedIn?: (user: User, token: string | null) => void,
  onSignedOut?: () => void
): () => void {
  const auth = getFirebaseAuth();
  if (!auth) {
    onSignedOut?.();
    return () => {};
  }

  return onAuthStateChanged(auth, (user) => {
    if (user) {
      if (cachedAccessToken) {
        onSignedIn?.(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        onSignedOut?.();
      }
    } else {
      cachedAccessToken = null;
      onSignedOut?.();
    }
  });
}

export function formatYouTubeAuthError(err: unknown): string {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code || '')
      : '';
  const message = err instanceof Error ? err.message : String(err || '');

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return `Google Sign-In window closed before completing. If Google showed "Error 403: access_denied (developer-approved testers)", open Setup > Google Cloud OAuth Permissions and add your YouTube channel Gmail under Audience > Test users for project ${firebaseConfig.projectId}.`;
  }
  if (code === 'auth/popup-blocked') {
    return 'Browser blocked the Google Sign-In popup. Allow popups for this site and tap Reconnect YouTube again.';
  }
  if (code === 'auth/unauthorized-domain') {
    return `Domain "${typeof window !== 'undefined' ? window.location.hostname : 'preview host'}" is not yet listed in Firebase Auth Authorized Domains. Add it in Setup > Firebase Authorized Domains.`;
  }
  if (message.toLowerCase().includes('access_denied') || message.toLowerCase().includes('insufficient')) {
    return 'YouTube OAuth scope denied or insufficient. Please click "Reconnect / Re-Authorize YouTube" to grant full YouTube Live & Chat permissions.';
  }
  return message || 'Unable to sign in with Google.';
}

export async function signInYouTube(): Promise<{ user: User; accessToken: string }> {
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error('Firebase Authentication could not be initialized in this browser context.');
  }

  isSigningIn = true;
  try {
    const result = await signInWithPopup(auth, buildProvider());
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Google Sign-In did not return a YouTube API access token. Please allow full YouTube permissions and try again.'
      );
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (err) {
    throw new Error(formatYouTubeAuthError(err));
  } finally {
    isSigningIn = false;
  }
}

export function getYouTubeAccessToken(): string | null {
  return cachedAccessToken;
}

export async function logoutYouTube(): Promise<void> {
  cachedAccessToken = null;
  const auth = getFirebaseAuth();
  if (auth) {
    await auth.signOut();
  }
}
