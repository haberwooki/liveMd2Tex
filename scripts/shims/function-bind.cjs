// Build shim (scripts/build.mjs aliases the npm package function-bind to this file): Node always has
// Function.prototype.bind, so function-bind's fallback, which builds a function from source text with the
// Function constructor, is never needed; the VSIX scan fails any Node-side bundle that contains such code
// (build gate 1, G1S-07).
module.exports = Function.prototype.bind;
