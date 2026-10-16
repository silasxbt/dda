export type TestChain = 'bsc' | 'solana';
export type Mode = 'scenario' | 'testnet';
export type Balances = Record<string, string>; // Raw integer amounts, including native fees.
export type Scenario = 'success' | 'no-profit' | 'stale' | 'inventory' | 'competition' | 'competition-unknown' | 'one-leg-fail' | 'timeout-landed' | 'disconnect' | 'expired' | 'reorg' | 'approval-fail' | 'account-fail' | 'fee-shortage';
export const scenarios: Scenario[] = ['success','no-profit','stale','inventory','competition','competition-unknown','one-leg-fail','timeout-landed','disconnect','expired','reorg','approval-fail','account-fail','fee-shortage'];
export interface QuotePlan {
 chain: TestChain; side: 'buy' | 'sell'; qty: string; spend: string; receive: string;
 maxSpend: string; minReceive: string; feeReserve: string; at: number; detail: Record<string, unknown>;
}
export interface Prepared {
 id: string; chain: TestChain; raw: string; expires?: number; meta: Record<string, unknown>;
}
export interface Settlement {
 state: 'confirmed' | 'failed' | 'unknown' | 'expired'; delta: Balances;
 fee?: string; block?: string; reason?: string;
}
export interface Operation {
 key: string; kind: 'buy' | 'sell' | 'setup' | 'unwind'; chain: TestChain;
 state: 'signed' | 'submitting' | 'submitted' | 'confirmed' | 'failed' | 'unknown' | 'expired' | 'cancelled';
 prepared: Prepared; plan?: QuotePlan; result?: Settlement; error?: string;
}
export interface Run {
 id: string; requestKey: string; mode: Mode; scenario: Scenario; createdAt: number; updatedAt: number;
 status: 'preparing' | 'running' | 'pending' | 'completed' | 'rejected' | 'exposed' | 'stopped' | 'recovered';
 qty: string; source: 'synthetic' | 'testnet-workflow'; before: Balances; after?: Balances;
 plans: QuotePlan[]; reservations: Balances; operations: Operation[]; stopRequested: boolean;
 reason?: string; reconciliation?: {ok: boolean; expected: Balances; actual: Balances};
 exposure: string; followups: {seconds: number; status: 'observed' | 'unknown'; quoteNet?: string; source: string}[];
 events: {at: number; message: string}[];
}
export interface TestAdapter {
 mode: Mode;
 check(): Promise<unknown>;
 balances(): Promise<Balances>;
 quote(chain: TestChain, side: 'buy' | 'sell', qty: string, scenario: Scenario): Promise<QuotePlan>;
 preflight(plans: QuotePlan[], scenario: Scenario): Promise<void>;
 prepare(plan: QuotePlan, key: string, scenario: Scenario): Promise<Prepared>;
 broadcast(tx: Prepared): Promise<void>;
 settlement(tx: Prepared): Promise<Settlement>;
 // Setup must use the same durable transaction journal as swaps.
 setup?(send: (key: string, chain: TestChain, build: () => Promise<Prepared>) => Promise<void>): Promise<unknown>;
}
export const balanceKey = (chain: TestChain, asset: 'A' | 'B' | 'native') => `${chain}:${asset}`;
export const decimals = (chain: TestChain, asset: 'A' | 'B' | 'native') => asset === 'native' ? (chain === 'bsc' ? 18 : 9) : chain === 'bsc' ? (asset === 'A' ? 6 : 18) : (asset === 'A' ? 9 : 6);
export const spendKey = (p: QuotePlan) => balanceKey(p.chain, p.side === 'buy' ? 'B' : 'A');
export const receiveKey = (p: QuotePlan) => balanceKey(p.chain, p.side === 'buy' ? 'A' : 'B');
