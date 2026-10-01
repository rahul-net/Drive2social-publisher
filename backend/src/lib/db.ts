import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getFirebaseApp } from "./firebaseAdmin.js";

// ============================================================
// Firestore access helper.
// Phases 3+ use getDb() to read/write user-scoped documents
// (publishJobs, publishHistory, connectedAccounts, ...).
// Throws FirebaseNotConfiguredError when Firebase Admin is unavailable.
// ============================================================

export function getDb(): Firestore {
  return getFirestore(getFirebaseApp());
}
