import { startSimpleDouble } from '../_simple-double.mjs';

const logPath = process.argv[2];
startSimpleDouble({ logPath, replyText: 'issued', refundImmediately: true });
