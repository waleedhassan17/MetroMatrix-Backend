/**
 * Which home-service providers a customer may see.
 *
 * One definition, used by provider search and by the home screen's category
 * counts, so a card that says "9+ Experts" never counts someone the list
 * behind it will not show.
 *
 * `hideFromSearch` keeps QA and smoke-test accounts ("Wallet Smoke Provider",
 * "Smoke Test Provider") out of what customers browse without deleting them —
 * the test harnesses still log in as them. It is set by
 * scripts/homeservice-data-hygiene.js, never by the app.
 */
function searchableProviderFilter(subType) {
  return {
    providerType: 'home_service',
    ...(subType ? { providerSubType: subType } : {}),
    adminVerified: 'active',
    isActive: true,
    hideFromSearch: { $ne: true },
  };
}

module.exports = { searchableProviderFilter };
