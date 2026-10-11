// Screen copy from Swish Playground Jayesh, v3. Amount and wallet names are filled at runtime.
export const guideCopy: Record<number, { title: string; body: string }> = {
  "1": {
    title: "Deposit from\nyour wallet.\nWithout opening it.",
    body: "Connect your wallet and set up Swish once. Then deposit on any device where your passkey is available. No wallet app needed there.",
  },
  "2": {
    title: "Set up once.\nCome back with\nyour passkey.",
    body: "Connect a wallet to get started. Already set up Swish? Use your existing passkey to go straight to your deposit.",
  },
  "3": {
    title: "Try it with your wallet.\nOr use ours.",
    body: "Connect your own wallet, or choose Demo Wallet for a test wallet with free funds. Both let you try the same Swish deposit flow.",
  },
  "4": {
    title: "A test wallet for\nyour first deposit.",
    body: "We're creating your Demo Wallet. We'll add test funds next, so you can try Swish without moving your own money.",
  },
  "5": {
    title: "A test wallet for\nyour first deposit.",
    body: "Your wallet is created. We're adding free test USDC so you can use it for the demo.",
  },
  "6": {
    title: "A test wallet for\nyour first deposit.",
    body: "Your wallet and test funds are ready. Next, you'll choose how much Swish can move from this wallet.",
  },
  "7": {
    title: "You choose\nhow much.",
    body: "Choose the total amount Swish may move from this wallet. Each deposit uses part of that limit and still needs your passkey.",
  },
  "8": {
    title: "Your passkey for\nfuture deposits.",
    body: "Create the passkey you'll use to approve deposits. Once your wallet is linked, you can use Swish on any device where that passkey is available.",
  },
  "9": {
    title: "Your passkey for\nfuture deposits.",
    body: "Complete the passkey prompt from your browser or device. Then your wallet can finish linking to Swish.",
  },
  "10": {
    title: "Your wallet approves\nthe setup.",
    body: "The first approval prepares Demo Wallet for Swish. The next links your passkey and sets the limit. Your deposit comes after setup.",
  },
  "11": {
    title: "Your wallet approves\nthe setup.",
    body: "The first approval is being confirmed. The next request will link your passkey and set the limit.",
  },
  "12": {
    title: "Your wallet approves\nthe setup.",
    body: "This approval links Demo Wallet to your passkey and sets your chosen limit. After setup, your passkey approves each deposit.",
  },
  "13": {
    title: "Your wallet approves\nthe setup.",
    body: "The approvals are complete. Swish is confirming your wallet link. Your first deposit is next.",
  },
  "14": {
    title: "Now try a deposit\nwith your passkey.",
    body: "Your wallet is linked. Approve this deposit with your passkey to see how future deposits will work. No wallet prompt.",
  },
  "15": {
    title: "Start with a connection\nto your wallet.",
    body: "Phantom will ask to connect. This lets Swish identify your wallet. You'll review the spending permission later.",
  },
  "16": {
    title: "Test funds for\na test deposit.",
    body: "This demo uses Solana Devnet and free test USDC. You can add funds here, or continue setup and return before signing.",
  },
  "17": {
    title: "Test funds for\na test deposit.",
    body: "We're waiting for the test funds to arrive. Your wallet stays connected. Once the funds are confirmed, you can continue setup.",
  },
  "18": {
    title: "Ready for\nthe next step.",
    body: "Your wallet has enough test USDC for this deposit. Continue to choose your spending limit.",
  },
  "19": {
    title: "You choose\nhow much.",
    body: "Choose the total amount Swish may move from this wallet. Each deposit uses part of that limit and still needs your passkey.",
  },
  "20": {
    title: "Your passkey for\nfuture deposits.",
    body: "Create the passkey you'll use to approve deposits. Once your wallet is linked, you can use Swish on any device where that passkey is available.",
  },
  "21": {
    title: "Your wallet approves\nthe setup.",
    body: "Review the first setup request in Phantom. A second request will link your passkey and set the limit. Your deposit comes after setup.",
  },
  "22": {
    title: "Your wallet approves\nthe setup.",
    body: "Review the link and your chosen limit in Phantom. After setup, your passkey approves deposits within that limit.",
  },
  "23": {
    title: "You can finish\nfunding later.",
    body: "Choose your limit and create your passkey now. You'll need test USDC before wallet signing, and test-funds help remains available.",
  },
  "24": {
    title: "We kept your\ntest wallet.",
    body: "We couldn't confirm the test funds. Retry with the same Demo Wallet, or choose your own wallet to continue.",
  },
  "25": {
    title: "Your setup\nis still here.",
    body: "Your connected wallet and chosen limit are kept. You can try creating your passkey again when you're ready.",
  },
  "26": {
    title: "Continue from\nwhere you stopped.",
    body: "Your passkey and any completed approval are kept. Resume to review the remaining wallet request.",
  },
  "27": {
    title: "Your wallet is\nstill connected.",
    body: "We couldn't confirm the test funds. You can retry for the same wallet, or return to setup and fund later.",
  },
  "28": {
    title: "Choose the wallet\nthat works for you.",
    body: "The connection didn't complete. Try your wallet again, or use Demo Wallet to continue with test funds.",
  },
  "29": {
    title: "Let's check before\ntrying again.",
    body: "Your setup request was sent, but confirmation is taking longer. Check its status before approving another request.",
  },
  "30": {
    title: "Your passkey\nis ready.",
    body: "Your wallet still needs test USDC before it can finish setup. Add funds here, then continue with the same passkey.",
  },
  "31": {
    title: "You can try this\nwithout a wallet app.",
    body: "Demo Wallet provides a test wallet and free test USDC in this browser. You'll still create a real passkey and try the deposit flow.",
  },
  "32": {
    title: "Your test funds\nare ready.",
    body: "If Phantom cannot approve the request, check that it uses Solana Devnet. Your wallet already has enough test USDC.",
  },
  "33": {
    title: "Approve this deposit\nwith your passkey.",
    body: "Complete the Touch ID prompt to approve 5 USDC. Your wallet app is not needed for this deposit.",
  },
  "34": {
    title: "Your deposit\nis on its way.",
    body: "Your passkey approval is complete. Swish is sending 5 USDC to your app account and paying the network fees.",
  },
  "35": {
    title: "Deposited.\nWith just your passkey.",
    body: "5 USDC has arrived in your app account. Next time, use your passkey again. Your wallet app can stay closed.",
  },
  "36": {
    title: "Your deposit\nis still waiting.",
    body: "Touch ID was cancelled. No funds moved. You can approve again when you are ready.",
  },
  "37": {
    title: "Approve the\ndeposit again.",
    body: "Swish could not accept that approval. Use your passkey again to continue with this deposit.",
  },
  "38": {
    title: "Your wallet needs\nmore test USDC.",
    body: "This deposit needs 5 USDC. Add test funds to this wallet before you approve the deposit.",
  },
  "39": {
    title: "Your limit needs\na little more.",
    body: "Your wallet has enough test USDC, but only 2 USDC remains in its limit. Add to the limit to make this 5 USDC deposit.",
  },
  "40": {
    title: "Checking your wallet\nand its limit.",
    body: "Swish is reading your balance and remaining limit. Your deposit will be ready to approve when the check is complete.",
  },
  "41": {
    title: "Your wallet is linked.\nIts balance is\nunavailable.",
    body: "Swish could not read your balance. You can still use your passkey to request the deposit. The service will check the funds and limit.",
  },
  "42": {
    title: "We could not confirm\nyour deposit.",
    body: "Swish could not confirm the result. Use Try again to continue.",
  },
  "43": {
    title: "This deposit\ndid not go through.",
    body: "No funds were taken. Close the widget to return to the playground.",
  },
  "44": {
    title: "This deposit\nis already finished.",
    body: "This request cannot be used again. Close the widget to return to the playground.",
  },
  "45": {
    title: "Welcome back.\nYour passkey is enough.",
    body: "Your wallet is already linked. Review the amount, then use your passkey to approve this deposit.",
  },
  "46": {
    title: "Your wallets.\nReady with your passkey.",
    body: "Your passkey found these linked wallets. Choose one that can cover this deposit, then approve it with your passkey.",
  },
  "47": {
    title: "Your linked wallets\nneed more funds or limit.",
    body: "None of these wallets can cover 5 USDC. Add USDC to a wallet or increase its spending limit before you deposit.",
  },
  "48": {
    title: "Your wallet choice\nis still here.",
    body: "Touch ID was cancelled. No funds moved. Use your passkey again when you are ready.",
  },
  "49": {
    title: "Your wallet approves\na higher limit.",
    body: "Connect the wallet whose limit you want to increase. Your existing passkey stays linked.",
  },
  "50": {
    title: "Choose how much\nto add.",
    body: "This wallet has 2 USDC left in its limit. Add enough for this deposit, or allow more for later deposits.",
  },
  "51": {
    title: "Approve the new limit\nin your wallet.",
    body: "Review the request in Phantom. This increases the limit. Your passkey will still approve the deposit.",
  },
  "52": {
    title: "Your limit is ready.\nNow make the deposit.",
    body: "The wallet approved the increase. Use your passkey to deposit 5 USDC.",
  },
  "53": {
    title: "Bring your Swish ID\nto this browser.",
    body: "Use your existing passkey to find your linked wallets. This step does not move any funds.",
  },
  "54": {
    title: "Finding the wallets\nlinked to your passkey.",
    body: "Your passkey is verified. Swish is finding your linked wallets so you can choose where this deposit comes from.",
  },
  "55": {
    title: "Your passkey\nwas not found.",
    body: "Try your existing passkey again, or connect a wallet to set up Swish in this browser.",
  },
  "56": {
    title: "Approve the deposit\nfrom this wallet.",
    body: "Complete the Touch ID prompt to approve 5 USDC from your selected wallet.",
  },
  "57": {
    title: "Your deposit\nis on its way.",
    body: "Your passkey approval is complete. Swish is sending 5 USDC from your selected wallet to your app account.",
  },
  "58": {
    title: "Getting your\ndeposit ready.",
    body: "Swish is loading the deposit details. The amount and destination will appear before you approve.",
  },
  "59": {
    title: "Connect the wallet\nyou want to update.",
    body: "Approve the connection in Phantom. Then choose how much to add to this wallet's limit.",
  },
  "60": {
    title: "Your wallet can\nstay here.",
    body: "Use any device where your same passkey is available. Open this deposit there and use the passkey you created during setup. No wallet connection needed.",
  },
  "61": {
    title: "Your wallet can\nstay here.",
    body: "Use any device where your same passkey is available. Open this deposit there and use the passkey you created during setup. No wallet connection needed.",
  },
  "62": {
    title: "Continue on\nyour other device.",
    body: "The link is open there. Use your same passkey to find your wallet and approve the deposit. This screen will show the result.",
  },
  "63": {
    title: "Approved there.\nSending your deposit.",
    body: "Your other device approved 5 USDC with your passkey. Swish is sending the deposit. The result will appear on both devices.",
  },
  "64": {
    title: "Deposited from\nyour other device.",
    body: "5 USDC has arrived in your app account. You used the same passkey on another device, without connecting your wallet there.",
  },
  "65": {
    title: "Let's open\na new link.",
    body: "Get a new link for this deposit, then open it on a device where your same passkey is available.",
  },
  "66": {
    title: "Your passkey.\nOn this device.",
    body: "Use any device where your same passkey is available. Use the passkey you created during setup. No wallet connection needed.",
  },
  "67": {
    title: "Use your same\npasskey here.",
    body: "Complete the passkey prompt to find your linked wallets. No funds move in this step.",
  },
  "68": {
    title: "Finding your\nlinked wallets.",
    body: "Your passkey is verified. Swish is finding the wallets linked to it. Your deposit comes next.",
  },
  "69": {
    title: "Your wallet.\nOn another device.",
    body: "Review this 5 USDC deposit, then approve it with your same passkey.",
  },
  "70": {
    title: "Approve this\ndeposit.",
    body: "Complete the Face ID prompt to approve 5 USDC from your linked wallet.",
  },
  "71": {
    title: "Your deposit\nis on its way.",
    body: "Your passkey approval is complete. Swish is sending 5 USDC to your app account.",
  },
  "72": {
    title: "Deposited.\nFrom this device.",
    body: "5 USDC has arrived in your app account. You used your same passkey here, without connecting your wallet. The original screen shows the result too.",
  },
  "73": {
    title: "Your passkey\nwas not found.",
    body: "Use any device where your same passkey is available. Try again here, or open the link on another device.",
  },
  "74": {
    title: "Your deposit\nis still waiting.",
    body: "Face ID was cancelled. No funds moved. Your wallet choice is kept, so you can approve again when you are ready.",
  },
  "75": {
    title: "This deposit\nis already complete.",
    body: "5 USDC has already arrived in your app account. This link shows the result. It cannot make the same deposit again.",
  },
  "76": {
    title: "You'll need\na new link.",
    body: "Open a new link from the original screen. Then use your same passkey here to continue.",
  },
  "77": {
    title: "Open it on\nanother device.",
    body: "Use any device where your same passkey is available. Copy this link, or scan the code from another device.",
  },
};
