import {
  Address,
  AssetId,
  Ed25519KeyHashHex,
  RewardAccount,
  Slot,
} from "@blaze-cardano/core";
import * as Data from "@blaze-cardano/data";
import { Emulator } from "@blaze-cardano/emulator";
import { Core, makeValue } from "@blaze-cardano/sdk";
import { beforeEach, describe, test } from "bun:test";
import {
  MultisigScript,
  TreasurySpendRedeemer,
  VendorConfiguration,
  VendorDatum,
  VendorVendorSpend,
  type TreasuryConfiguration,
  type TreasuryTreasuryWithdraw,
} from "../../src/generated-types/contracts";
import {
  constructScripts,
  loadTreasuryScript,
  loadVendorScript,
  coreValueToContractsValue as translateValue,
} from "../../src/shared";
import { fund } from "../../src/treasury/fund";
import {
  Funder,
  Vendor,
  fund_key,
  registryToken,
  sampleTreasuryConfig,
  sampleVendorConfig,
  setupEmulator,
  vendor_key,
} from "../utilities";

describe("When funding", () => {
  const amount = 340_000_000_000_000n;

  let emulator: Emulator;
  let configs: {
    treasury: TreasuryConfiguration;
    vendor: VendorConfiguration;
    trace: boolean;
  };
  let scriptInput: Core.TransactionUnspentOutput;
  let secondScriptInput: Core.TransactionUnspentOutput;
  let thirdScriptInput: Core.TransactionUnspentOutput;
  let fourthScriptInput: Core.TransactionUnspentOutput;
  let refInput: Core.TransactionUnspentOutput;
  let registryInput: Core.TransactionUnspentOutput;
  let vendor: MultisigScript;
  let rewardAccount: RewardAccount;
  let treasuryScript: TreasuryTreasuryWithdraw;
  let vendorScript: VendorVendorSpend;
  let treasuryScriptAddress: Address;
  let vendorScriptAddress: Address;

  beforeEach(async () => {
    emulator = await setupEmulator();
    const treasuryConfig = await sampleTreasuryConfig(emulator);
    const vendorConfig = await sampleVendorConfig(emulator);
    const treasuryScriptManifest = loadTreasuryScript(
      Core.NetworkId.Testnet,
      treasuryConfig,
      true,
    );
    const vendorScriptManifest = loadVendorScript(
      Core.NetworkId.Testnet,
      vendorConfig,
      true,
    );
    configs = { treasury: treasuryConfig, vendor: vendorConfig, trace: true };
    rewardAccount = treasuryScriptManifest.rewardAccount!;
    treasuryScript = treasuryScriptManifest.script;
    vendorScript = vendorScriptManifest.script;
    treasuryScriptAddress = treasuryScriptManifest.scriptAddress;
    vendorScriptAddress = vendorScriptManifest.scriptAddress;

    emulator.accounts.set(rewardAccount, amount);

    vendor = {
      Signature: {
        key_hash: await vendor_key(emulator),
      },
    };

    scriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 0n),
      new Core.TransactionOutput(
        treasuryScriptAddress,
        makeValue(500_000_000_000n),
      ),
    );
    scriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(scriptInput);

    secondScriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 1n),
      new Core.TransactionOutput(
        treasuryScriptAddress,
        makeValue(100_000_000_000n),
      ),
    );
    secondScriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(secondScriptInput);

    thirdScriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 2n),
      new Core.TransactionOutput(
        treasuryScriptAddress,
        makeValue(500_000n, ["a".repeat(56), 1n]), // Below minUTxO to test equals_plus_min_ada
      ),
    );
    // TODO: update blaze to allow spending null datums for plutus v3
    thirdScriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(thirdScriptInput);

    fourthScriptInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 2n),
      new Core.TransactionOutput(
        treasuryScriptAddress,
        makeValue(50_000_000n, ["b".repeat(56), 100n]), // Below minUTxO to test equals_plus_min_ada
      ),
    );
    // TODO: update blaze to allow spending null datums for plutus v3
    fourthScriptInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(fourthScriptInput);

    const [registryPolicy, registryName] = registryToken();
    registryInput = emulator.utxos().find((u) =>
      u
        .output()
        .amount()
        .multiasset()
        ?.get(AssetId(registryPolicy + registryName)),
    )!;

    refInput = emulator.lookupScript(treasuryScript.Script);
  });

  describe("the treasury oversight committee", () => {
    describe("before the expiration", async () => {
      test("can fund a new project", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: scriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(10_000_000_000n),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project without change", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: scriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(500_000_000_000n),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project with multiple payouts", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: scriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(250_000_000_000n),
              },
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(250_000_000_000n),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project with native tokens", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: fourthScriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(10_000_000n),
              },
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(10_000_000n, ["b".repeat(56), 50n]),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project by providing the treausry script bytes manually", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          const scripts = constructScripts(
            Core.NetworkId.Testnet,
            configs.treasury,
            treasuryScript.Script,
            configs.vendor,
            vendorScript.Script,
          );
          return fund({
            configsOrScripts: { configs, scripts },
            blaze,
            input: fourthScriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(0n, ["b".repeat(56), 50n]),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });

        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project by providing the treausry script ref manually", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          const scripts = constructScripts(
            Core.NetworkId.Testnet,
            configs.treasury,
            treasuryScript.Script,
            configs.vendor,
            vendorScript.Script,
            Core.TransactionUnspentOutput.fromCore([
              {
                index: 9,
                txId: Core.TransactionId("0".repeat(64)),
              },
              {
                address: Core.PaymentAddress(
                  "addr_test1wza7ec20249sqg87yu2aqkqp735qa02q6yd93u28gzul93gvc4wuw",
                ),
                value: new Core.Value(5000001n).toCore(),
                scriptReference: treasuryScript.Script.asPlutusV3()?.toCore(),
              },
            ]),
          );
          return fund({
            configsOrScripts: { configs, scripts },
            blaze,
            input: fourthScriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(0n, ["b".repeat(56), 50n]),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });

        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project with *only* native tokens", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: fourthScriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(0n, ["b".repeat(56), 50n]),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("can fund a new project with minUtXO problems", async () => {
        const tx = await emulator.as(Funder, async (blaze) => {
          return fund({
            configsOrScripts: { configs },
            blaze,
            input: fourthScriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(25_000_000n),
              },
              {
                date: new Date(Number(emulator.slotToUnix(Slot(12)))),
                amount: makeValue(25_000_000n, ["b".repeat(56), 50n]),
              },
            ],
            signers: [
              Ed25519KeyHashHex(await fund_key(emulator)),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          });
        });
        await emulator.expectValidMultisignedTransaction([Funder, Vendor], tx);
      });
      test("cannot attach different stake address to vendor script", async () => {
        const fullAddress = new Core.Address({
          type: Core.AddressType.BasePaymentScriptStakeKey,
          networkId: Core.NetworkId.Testnet,
          paymentPart: {
            type: Core.CredentialType.ScriptHash,
            hash: vendorScript.Script.hash(),
          },
          delegationPart: {
            type: Core.CredentialType.KeyHash,
            hash: treasuryScript.Script.hash(), // Just use an arbitrary hash
          },
        });
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(10_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.expiration / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: value,
                  },
                }),
              )
              .lockAssets(
                fullAddress,
                makeValue(10_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                treasuryScriptAddress,
                makeValue(499_990_000_000n),
                Data.Void(),
              ),
            /Trace expect or {\s*allow_different_stake/,
          );
        });
      });
      test("cannot attach different stake address to change", async () => {
        const fullAddress = new Core.Address({
          type: Core.AddressType.BasePaymentScriptStakeKey,
          networkId: Core.NetworkId.Testnet,
          paymentPart: {
            type: Core.CredentialType.ScriptHash,
            hash: treasuryScript.Script.hash(),
          },
          delegationPart: {
            type: Core.CredentialType.KeyHash,
            hash: treasuryScript.Script.hash(), // Just use an arbitrary hash
          },
        });
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(10_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.expiration / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: value,
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(10_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                fullAddress,
                makeValue(499_990_000_000n),
                Data.Void(),
              ),
            /Trace expect or {\s*allow_different_stake/,
          );
        });
      });
      test("cannot steal funds", async () => {
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(1_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.expiration / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: value,
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(1_000_000n),
                Data.serialize(VendorDatum, datum),
              ),
            /Trace equal_plus_min_ada\(merge\(input_sum, negate\(amount\)\), output_sum\)/,
          );
        });
      });
      test("cannot mismatch redeemer and datum payout", async () => {
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(1_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.expiration / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: translateValue(makeValue(2_000_000n)),
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(1_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                treasuryScriptAddress,
                makeValue(49_999_000_000n),
                Data.Void(),
              ),
            /Trace payout_sum == amount/,
          );
        });
      });
      test("cannot mismatch redeemer and actual payout", async () => {
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(1_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.expiration / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: translateValue(makeValue(1_000_000n)),
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(2_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                treasuryScriptAddress,
                makeValue(49_998_000_000n),
                Data.Void(),
              ),
            /Trace equal_plus_min_ada\(merge\(input_sum, negate\(amount\)\), output_sum\)/,
          );
        });
      });
      test("cannot fund past payout upperbound", async () => {
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(1_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(configs.treasury.payout_upperbound * 2n),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(configs.treasury.payout_upperbound / 1000n) - 1),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: value,
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(1_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                treasuryScriptAddress,
                makeValue(499_999_000_000n),
                Data.Void(),
              ),
            /Trace expect p.maturation <= config.payout_upperbound/,
          );
        });
      });
    });
    describe("after the expiration", async () => {
      beforeEach(async () => {
        emulator.stepForwardToUnix(configs.treasury.expiration + 1n);
      });
      test("cannot fund a new project", async () => {
        await emulator.as(Funder, async (blaze) => {
          const value = translateValue(makeValue(1_000_000n));
          const datum: VendorDatum = {
            vendor,
            payouts: [
              {
                maturation: BigInt(10n),
                value,
                status: "Active",
              },
            ],
          };
          await emulator.expectScriptFailure(
            blaze
              .newTransaction()
              .setValidUntil(
                Slot(Number(5000n + configs.treasury.expiration / 1000n)),
              )
              .addReferenceInput(registryInput)
              .addReferenceInput(refInput)
              .addRequiredSigner(Ed25519KeyHashHex(await fund_key(emulator)))
              .addRequiredSigner(Ed25519KeyHashHex(await vendor_key(emulator)))
              .addInput(
                scriptInput,
                Data.serialize(TreasurySpendRedeemer, {
                  Fund: {
                    amount: value,
                  },
                }),
              )
              .lockAssets(
                vendorScriptAddress,
                makeValue(1_000_000n),
                Data.serialize(VendorDatum, datum),
              )
              .lockAssets(
                treasuryScriptAddress,
                makeValue(499_999_000_000n),
                Data.Void(),
              ),
            /Trace is_entirely_before\(/,
          );
        });
      });
    });
  });

  describe("a malicious user", () => {
    test("cannot fund projects", async () => {
      await emulator.as("MaliciousUser", async (blaze, address) => {
        await emulator.expectScriptFailure(
          await fund({
            configsOrScripts: { configs },
            blaze,
            input: scriptInput,
            vendor,
            schedule: [
              {
                date: new Date(Number(emulator.slotToUnix(Slot(10)))),
                amount: makeValue(10_000_000_000n),
              },
            ],
            signers: [
              Ed25519KeyHashHex(address.asBase()!.getPaymentCredential().hash),
              Ed25519KeyHashHex(await vendor_key(emulator)),
            ],
          }),
          /Trace satisfied\(permissions.fund/,
        );
      });
    });
  });
});
