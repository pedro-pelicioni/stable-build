export function Balances({ native, erc20 }: { native: string; erc20: string }) {
  return (
    <dl>
      <dt>Native USDC</dt>
      <dd>{native}</dd>
      <dt>ERC-20 USDC</dt>
      <dd>{erc20}</dd>
    </dl>
  );
}
