// The API server hosts the existing ShowMe processor implementation.  Keep
// its startup lifecycle intact so readiness and durable processing checks are
// not bypassed by the artifact wrapper.
import "./processor/index.js";
