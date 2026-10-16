import { encodeFunctionData } from "viem";

import { ticketChainAbi } from "./abi.js";
import type { Hex } from "./ports.js";

export function encodeCheckIn(tokenId: number | bigint): Hex {
  return encodeFunctionData({
    abi: ticketChainAbi,
    functionName: "checkIn",
    args: [BigInt(tokenId)],
  });
}
