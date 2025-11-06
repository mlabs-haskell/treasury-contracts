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
  ScriptHashRegistry,
} from "../../src/generated-types/contracts";
import {
  coreAddressToContractsAddress,
  loadAllowlistScript,
  loadTreasuryScript,
  loadVendorScript,
  TConfigsOrScripts,
} from "../../src/shared";
import { withdraw } from "../../src/vendor/withdraw";
import {
  fund_key,
  Funder,
  modify_key,
  registryToken,
  sampleTreasuryConfig,
  sampleVendorConfig,
  setupEmulator,
  Vendor,
  vendor_key,
} from "../utilities";
import { fund } from "src/treasury/fund";

describe("MLabs Audit Findings 2", () => {
  const amount = 340_000_000_000_000n;

  let emulator: Emulator;
  let treasuryInput: Core.TransactionUnspentOutput;
  let vendorSigner: Ed25519KeyHashHex;
  let modifySigner: Ed25519KeyHashHex;
  let rewardAccount: RewardAccount;
  let vendorScriptAddress: Address;
  let configsOrScripts: TConfigsOrScripts;
  let allowedAddresses: Address[];

  beforeEach(async () => {
    emulator = await setupEmulator();

    const treasuryConfig = await sampleTreasuryConfig(emulator);
    const vendorConfig = await sampleVendorConfig(emulator);

    configsOrScripts = {
      configs: { treasury: treasuryConfig, vendor: vendorConfig, trace: true },
    };


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

    rewardAccount = treasuryScriptManifest.rewardAccount!;
    vendorScriptAddress = vendorScriptManifest.scriptAddress;

    emulator.accounts.set(rewardAccount, amount);

    allowedAddresses = await Promise.all([
      emulator.register("Allowed 1"),
      emulator.register("Allowed 2"),
      emulator.register("Allowed 3"),
    ]);


    vendorSigner = Ed25519KeyHashHex(await vendor_key(emulator));
    modifySigner = Ed25519KeyHashHex(await modify_key(emulator));

    treasuryInput = new Core.TransactionUnspentOutput(
      new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 5n),
      new Core.TransactionOutput(
        treasuryScriptManifest.scriptAddress,
        makeValue(500_000_000_000n),
      ),
    );
    treasuryInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
    emulator.addUtxo(treasuryInput);


  });

  test("should not be able to create allow-list with invalid registry", async () => {
    emulator.stepForwardToSlot(2000n);
    await emulator.as(Vendor, async (blaze, _) => {
      const treasuryConfig = await sampleTreasuryConfig(emulator);
      const wrongVendorConfig = await sampleVendorConfig(emulator, 1);
      const wrongRegistryToken = registryToken(1);

      const treasuryScriptManifest = loadTreasuryScript(
        Core.NetworkId.Testnet,
        treasuryConfig,
        true,
      );
      const wrongVendorScriptManifest = loadVendorScript(
        Core.NetworkId.Testnet,
        wrongVendorConfig,
        true,
      );

      await emulator.register(
        "Wrong Registry",
        makeValue(5_000_000n, [wrongRegistryToken.join(""), 1n]),
        Data.serialize(ScriptHashRegistry, {
          treasury: {
            Script: [treasuryScriptManifest.credential.hash],
          },
          vendor: {
            Script: [wrongVendorScriptManifest.credential.hash],
          },
        }),
      );

      const wrongRegistryInput = await blaze.provider.getUnspentOutputByNFT(
        AssetId(wrongRegistryToken.join("")),
      );

      const wrongAllowedAddress = await emulator.register("Adversary address");

      const wrongAllowlist = loadAllowlistScript(Core.NetworkId.Testnet, {
        registry_token: wrongRegistryToken[0],
        addresses: [coreAddressToContractsAddress(wrongAllowedAddress)],
      });

      emulator.accounts.set(wrongAllowlist.rewardAccount!, 0n);
      await emulator.publishScript(wrongAllowlist.script.Script);

      const vendor = {
        Script: {
          script_hash: wrongAllowlist.script.Script.hash(),
        },
      };

      const fundTx = await emulator.as(Funder, async (blaze) => {
        let txBuilder = await fund({
          configsOrScripts,
          blaze,
          input: treasuryInput,
          vendor,
          schedule: [
            {
              date: new Date(Number(emulator.slotToUnix(Slot(10)))),
              amount: makeValue(10_000_000_000n),
            },
          ],
          signers: [
            Ed25519KeyHashHex(await fund_key(emulator)),
          ],
          additionalScripts: [
            { script: wrongAllowlist.script.Script, redeemer: Data.Void() },
          ],
        });

        // This transaction should fail because of the invalid allow address script
        emulator.expectScriptFailure(txBuilder);

        txBuilder.addReferenceInput(wrongRegistryInput);

        let tx = await txBuilder.complete();
        tx = await blaze.signTransaction(tx);
        return tx;
      });

      const fundTxId = await emulator.submitTransaction(fundTx);

      emulator.awaitTransactionConfirmation(fundTxId);

      await emulator.as(Vendor, async (blaze) => {
        const scriptInputs = await blaze.provider.getUnspentOutputs(vendorScriptAddress);

        emulator.expectScriptFailure(
          await withdraw({
            configsOrScripts: configsOrScripts,
            blaze,
            now: new Date(Number(emulator.slotToUnix(Slot(2)))),
            inputs: scriptInputs,
            destination: allowedAddresses[0],
            signers: [vendorSigner],
            additionalScripts: [
              { script: wrongAllowlist.script.Script, redeemer: Data.Void() },
            ],
          })
        );
      })
    });
  });
});

