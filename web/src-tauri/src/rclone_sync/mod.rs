//! Secure rclone authorization and transport for scoped text/board sync.
pub(crate) mod auth;
mod engine;
pub(crate) mod selective;
#[cfg(test)] mod legacy;

use crate::google::incremental::{hash, ticket as new_id};
// Old full-workspace revisions are deliberately never listed or reused.
const ROOT: &str = "Comet-Sync/text-v2";
