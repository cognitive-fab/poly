import { startConfirmDouble } from '../_confirm-double.mjs';

const logPath = process.argv[2];
startConfirmDouble({
  logPath,
  askText: 'You asked for a refund of $40.00. Reply YES to confirm or NO to cancel.',
  refundAfterConfirms: 1,
  keyBehaviour: 'fresh',
});
