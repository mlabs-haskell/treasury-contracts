import {
  Ed25519KeyHashHex,
  Slot,
} from "@blaze-cardano/core";
import * as Data from "@blaze-cardano/data";
import { Core, makeValue } from "@blaze-cardano/sdk";
import { describe, test } from "bun:test";
import {
  VendorDatum,
} from "../src/generated-types/contracts";
import {
  coreAddressToContractsAddress,
  coreValueToContractsValue,
  loadAllowlistScript,
  loadTreasuryScript,
  loadVendorScript,
} from "../src/shared";
import { withdraw } from "../src/vendor/withdraw";
import {
  sampleTreasuryConfig,
  sampleVendorConfig,
  setupEmulator,
  Vendor,
  vendor_key,
} from "../tests/utilities";
import fs from "node:fs";
import { CategoryScale, Chart, LinearScale, LineController, LineElement, PointElement } from 'chart.js';
import { createCanvas } from "canvas";

type ExecutionUnits = {
  steps: number, mem: number
}

type AllowListBenchOpts = {
  assets: string[]
  outputAddresses: number
  allowListAddresses: number
}


type ExUnitData = {
  xs: number[],
  xLabel: string,
  mem: number[],
  steps: number[]
}


// FIXME: For some reason, if the benchmarks are run after each other, the second one would fail with
// a WASM error: RuntimeError: Unreachable code should not be executed (evaluating 'wasm.eval_phase_two_raw(..)') 
describe("Benchmark: execution unit changes with allowlist length", () => {
  test("bench1: withdraw a payout to single address", async () => {
    const xs = [];
    const mem = [];
    const steps = [];

    for (let i = 10; i < 300; i += 10) {
      try {
        const exUnits = await runWithNAddresses({ assets: [], outputAddresses: 1, allowListAddresses: i },)

        xs.push(i);
        mem.push(exUnits.mem);
        steps.push(exUnits.steps);
      } catch (err) {
        if (typeof err === "string") {
          if (err.includes("execution went over budget")) {
            break;
          }
        }

        throw err;
      }
    }

    await printExUnitChart("./benchmarks/results/allow-list-single-addr.png",
      { xs, xLabel: "Allow-list address count", mem, steps }
    )
  });


  test("bench2: withdraw a payout to multiple addresses", async () => {
    const xs = [];
    const mem = [];
    const steps = [];

    for (let i = 10; i < 300; i += 2) {
      try {
        const exUnits = await runWithNAddresses({ assets: [], outputAddresses: i, allowListAddresses: i },)

        xs.push(i);
        mem.push(exUnits.mem);
        steps.push(exUnits.steps);
      } catch (err) {
        if (typeof err === "string") {
          if (err.includes("execution went over budget")) {
            break;
          }
        }

        throw err;
      }
    }

    await printExUnitChart("./benchmarks/results/allow-list-multi-addr.png",
      { xs, xLabel: "Allow-list address count", mem, steps }
    )
  });

  test("bench3: withdraw a multiasset payout to multiple addresses", async () => {
    const xs = [];
    const mem = [];
    const steps = [];

    const assets =
      ["b".repeat(56),
      "c".repeat(56),
      "d".repeat(56),
      ];

    for (let i = 10; i < 300; i += 2) {
      try {
        const exUnits = await runWithNAddresses({ assets, outputAddresses: i, allowListAddresses: i })

        xs.push(i);
        mem.push(exUnits.mem);
        steps.push(exUnits.steps);
        i += 1;
      } catch (err) {
        if (typeof err === "string") {
          if (err.includes("execution went over budget")) {
            break;
          }
        }

        throw err;
      }
    }

    await printExUnitChart("./benchmarks/results/allow-list-multiasset.png",
      { xs, xLabel: "Allow-list address count", mem, steps }
    )
  });
});

// Run a bencmark on the vendor contract using the allow-list with increasing number of addresses.
async function runWithNAddresses(options: AllowListBenchOpts): Promise<ExecutionUnits> {
  const amount = 340_000_000_000_000n;
  const emulator = await setupEmulator();
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
  const configsOrScripts = {
    configs: { treasury: treasuryConfig, vendor: vendorConfig, trace: true },
  };
  const rewardAccount = treasuryScriptManifest.rewardAccount!;
  const vendorScriptAddress = vendorScriptManifest.scriptAddress;

  emulator.accounts.set(rewardAccount, amount);


  const vendorSigner = Ed25519KeyHashHex(await vendor_key(emulator));

  const treasuryInput = new Core.TransactionUnspentOutput(
    new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 5n),
    new Core.TransactionOutput(
      treasuryScriptManifest.scriptAddress,
      makeValue(500_000_000_000n),
    ),
  );
  treasuryInput.output().setDatum(Core.Datum.newInlineData(Data.Void()));
  emulator.addUtxo(treasuryInput);

  emulator.stepForwardToSlot(2000n);

  const allowedAddresses = await Promise.all(
    Array.from({ length: options.allowListAddresses }, (_, i) => emulator.register(`Allowed ${i}`))
  );

  const allowlist = loadAllowlistScript(Core.NetworkId.Testnet, {
    registry_token: vendorConfig.registry_token,
    addresses: allowedAddresses.map(coreAddressToContractsAddress),
  });
  emulator.accounts.set(allowlist.rewardAccount!, 0n);
  await emulator.publishScript(allowlist.script.Script);

  const vendor = {
    AllOf: {
      scripts: [
        {
          Signature: {
            key_hash: await vendor_key(emulator),
          },
        },
        {
          Script: {
            script_hash: allowlist.script.Script.hash(),
          },
        },
      ],
    },
  };

  const scriptInput = new Core.TransactionUnspentOutput(
    new Core.TransactionInput(Core.TransactionId("1".repeat(64)), 1n),
    new Core.TransactionOutput(
      vendorScriptAddress,
      makeValue(500_000_000_000n,
        ...options.assets.map<[string, bigint]>(asset => [asset, 500_000_000_000n]),
      )
    ),
  );
  const vendorDatum: VendorDatum = {
    vendor: vendor,
    payouts: [
      {
        maturation: 1000n,
        value: coreValueToContractsValue(makeValue(500_000_000_000n,
          ...options.assets.map<[string, bigint]>(asset => [asset, 500_000_000_000n]),
        )),
        status: "Active",
      },
    ],
  };
  scriptInput
    .output()
    .setDatum(
      Core.Datum.newInlineData(Data.serialize(VendorDatum, vendorDatum)),
    );
  emulator.addUtxo(scriptInput);

  const remainder = BigInt(500_000_000_000 - ((options.outputAddresses - 1) * 10_000_000));

  const txBuilder = await emulator.as(Vendor, async (blaze, _) => {
    return await withdraw({
      configsOrScripts,
      blaze,
      now: new Date(Number(emulator.slotToUnix(Slot(2)))),
      inputs: [scriptInput],
      destinations: [
        ...Array.from({ length: options.outputAddresses - 1 }, (_, i) => (
          {
            address: allowedAddresses[i],
            amount: makeValue(10_000_000n,
              ...options.assets.map<[string, bigint]>(asset => [asset, 10_000_000n]),

            ),
          })),
        {
          address: allowedAddresses[(options.allowListAddresses - 1)],
          amount:
            makeValue(remainder,
              ...options.assets.map<[string, bigint]>(asset => [asset, remainder]),
            )
        },
      ],
      signers: [vendorSigner],
      additionalScripts: [
        { script: allowlist.script.Script, redeemer: Data.Void() },
      ],
    });
  });

  const tx = await txBuilder.complete();

  return tx.witnessSet().redeemers()?.toCore().reduce((exUnits, r) =>
  ({
    steps: exUnits.steps + r.executionUnits.steps,
    mem: exUnits.mem + r.executionUnits.memory
  }), { steps: 0, mem: 0 }) || { steps: 0, mem: 0 };
}

Chart.register([
  CategoryScale,
  LineController,
  LineElement,
  LinearScale,
  PointElement
]);

// Generate an execution units line chart and print to png file
async function printExUnitChart(path: string, { xs, xLabel, mem, steps }: ExUnitData) {
  const canvas = createCanvas(800, 600);
  const chart = new Chart(
    canvas as any,
    {
      type: 'line',
      options: {
        scales: {
          x: {
            title: { display: true, text: xLabel, font: { size: 20 } }
          },
          y1: {
            type: "linear",
            title: { display: true, text: "Memory", color: "red", font: { size: 20 } },
            display: true,
            position: "left",
            min: 0,
            max: 10000000

          },
          y2: {
            type: "linear",
            title: { display: true, text: "Steps", color: "blue", font: { size: 20 } },
            display: true,
            position: "right",
            min: 0,
            max: 10000000000
          }
        },
      },
      data: {
        labels: xs,
        datasets: [
          {
            label: "Memory",
            data: mem,
            borderColor: "red",
            yAxisID: "y1"
          },
          {
            label: "Steps",
            data: steps,
            borderColor: "blue",
            yAxisID: "y2"
          }
        ]
      }
    }
  );

  const pngBuffer = canvas.toBuffer();
  await fs.promises.writeFile(path, pngBuffer);
  chart.destroy();
}
