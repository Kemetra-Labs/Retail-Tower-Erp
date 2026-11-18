/**
 * The `context` module's port (RT-1453 module boundaries). Other modules import from here, not
 * from the files inside. RT-1470 opens it with the effective caller role.
 */
export {
  PLATFORM_ADMIN_EFFECTIVE_ROLE,
  effectiveRoleCode,
  findCallerRoleCode,
  isSessionPlatformAdmin,
} from "./effective-role";
