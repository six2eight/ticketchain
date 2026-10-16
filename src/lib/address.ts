import { isAddress, isAddressEqual, type Address } from "viem";

export { isAddressEqual };

/** Addresses are stored lowercase everywhere in the DB. */
export const lower = (address: string) => address.toLowerCase() as Address;

export function isValidAddress(value: string): value is Address {
  return isAddress(value, { strict: false });
}

export const zeroAddressLower = "0x0000000000000000000000000000000000000000";
