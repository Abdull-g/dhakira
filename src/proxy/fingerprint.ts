// Compatibility re-export. The implementation moved to src/store/fingerprint.ts in
// v0.3.1 (Standing Order #7: engine code must not import values from src/proxy/).
// Proxy-side callers keep importing from here; engine code imports from store/.
export { computeContextFingerprint } from '../store/fingerprint.js'
