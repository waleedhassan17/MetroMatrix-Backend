/**
 * `emailVerified` is not the same type on both account models:
 *
 *   User.emailVerified     Boolean
 *   Provider.emailVerified String enum — 'pending' | 'active' | 'inactive'
 *
 * Assigning `true` to a Provider casts it to the string "true", which is not
 * in the enum, so the save throws a ValidationError. Several shared code
 * paths (social login/signup, token verification, manual verify) handle both
 * account types with one branch and hit exactly that. Use this helper
 * wherever the model isn't statically known.
 *
 * @param {'user'|'provider'} userType
 * @returns {true|'active'} the verified value that model accepts
 */
const verifiedEmailFlag = (userType) => (userType === 'provider' ? 'active' : true);

module.exports = { verifiedEmailFlag };
