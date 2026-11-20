export type FailureState = { timedOut: boolean; reachable: boolean };

// Three different things go wrong with the local service and they deserve different instructions.
// Reachability is probed after the failure, because "the connection closed" and "nothing is listening"
// look identical to fetch.
export function requestFailureMessage({ timedOut, reachable }: FailureState): string {
  if (timedOut) return 'The local service took too long to answer. Try again.';
  if (reachable) return 'The local service dropped the connection while answering. Try again.';
  return 'Cue cannot reach its local service. Start it with npm start, then try again.';
}
