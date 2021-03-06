import { lock, getRedisClient } from "../../redis";
import * as metrics from "../../metrics";
import { User, WalletApplication } from "../../models/users";
import * as db from "../../models/orders";
import * as offerDb from "../../models/offers";
import { OrderValue } from "../../models/offers";
import { getDefaultLogger as logger } from "../../logging";
import { pick, capitalizeFirstLetter, parseMemo, transferKey } from "../../utils/utils";
import { Application, AppOffer } from "../../models/applications";
import {
	isPayToUser,
	isExternalEarn,
	ExternalEarnOrderJWT,
	ExternalSpendOrderJWT,
	validateExternalOrderJWT,
	ExternalPayToUserOrderJWT
} from "./native_offers";
import {
	ApiError,
	NoSuchApp,

	NoSuchUser,
	CompletedOrderCantTransitionToFailed,
	ExternalOrderAlreadyCompleted,
	MarketplaceError,
	NoSuchOffer,
	NoSuchOrder,
	UserHasNoWallet,
	OfferCapReached,
	OpenedOrdersOnly,
	OpenedOrdersUnreturnable,
	OpenOrderExpired,
	TransactionTimeout, MissingField
} from "../../errors";

import { Paging } from "./index";
import * as payment from "./payment";
import { addWatcherEndpoint } from "./payment";
import {
	create as createEarnTransactionBroadcastToBlockchainSubmitted
} from "../../analytics/events/earn_transaction_broadcast_to_blockchain_submitted";
import {
	create as createSpendTransactionBroadcastToBlockchainSubmitted
} from "../../analytics/events/spend_transaction_broadcast_to_blockchain_submitted";
import { OrderTranslations } from "../routes/orders";
import { assertRateLimitEarn } from "../../utils/rate_limit";
import { submitFormAndMutateMarketplaceOrder } from "./offer_contents";

export interface OrderList {
	orders: Order[];
	paging: Paging;
}

export interface BaseOrder {
	id: string;
	offer_id: string;
	offer_type: offerDb.OfferType;
	title: string;
	description: string;
	amount: number;
	nonce: string;
	blockchain_data: offerDb.BlockchainData;
}

export interface OpenOrder extends BaseOrder {
	expiration_date: string;
}

export interface Order extends BaseOrder {
	error?: ApiError | null;
	content?: string; // json serialized payload of the coupon page
	status: db.OrderStatus;
	completion_date: string; // UTC ISO
	result?: OrderValue;
	call_to_action?: string;
	origin: db.OrderOrigin;
}

export async function getOrder(orderId: string, user: User): Promise<Order> {
	const order = await db.Order.getOne({ orderId, status: "!opened" });

	if (!order || order.contextForUser(user.id) === null) {
		throw NoSuchOrder(orderId);
	}

	checkIfTimedOut(order); // no need to wait for the promise

	const wallet = (await user.getWallets()).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(user.id);
	}

	return await orderDbToApi(order, user.id, wallet.address);
}

export async function changeOrder(orderId: string, user: User, change: Partial<Order>): Promise<Order> {
	const order = await db.Order.getOne({ orderId, status: "!opened" });

	if (!order || order.contextForUser(user.id) === null) {
		throw NoSuchOrder(orderId);
	}
	if (order.status === "completed") {
		throw CompletedOrderCantTransitionToFailed();
	}

	order.error = change.error;
	order.status = "failed";
	await order.save();

	const wallet = (await user.getWallets()).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(user.id);
	}

	logger().debug("order patched with error", { orderId, contexts: order.contexts, error: change.error });
	return await orderDbToApi(order, user.id, wallet.address);
}

async function createOrder(appOffer: AppOffer, user: User, userDeviceId: string, orderTranslations = {} as OrderTranslations) {
	const wallet = (await user.getWallets(userDeviceId)).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(user.id, userDeviceId);
	}

	if (await appOffer.didExceedCap(user.id)) {
		return undefined;
	}

	const orderMeta = appOffer.offer.meta.order_meta;
	orderMeta.title = orderTranslations.orderTitle || orderMeta.title;
	orderMeta.description = orderTranslations.orderDescription || orderMeta.description;

	const recipientAddress = appOffer.offer.type === "spend" ? appOffer.walletAddress : wallet.address;
	const senderAddress = appOffer.offer.type === "spend" ? wallet.address : appOffer.walletAddress;

	const order = db.MarketplaceOrder.new({
		status: "opened",
		offerId: appOffer.offer.id,
		amount: appOffer.offer.amount,
		blockchainData: {
			sender_address: senderAddress,
			recipient_address: recipientAddress,
		}
	}, {
		user,
		wallet: wallet.address,
		type: appOffer.offer.type,
		// TODO if order meta content is a template:
		// replaceTemplateVars(offer, offer.meta.order_meta.content!)
		meta: orderMeta
	});

	await order.save();

	metrics.createOrder("marketplace", appOffer.offer.type, user.appId);

	return order;
}

export async function createMarketplaceOrder(offerId: string, user: User, userDeviceId: string, orderTranslations?: OrderTranslations): Promise<OpenOrder> {
	logger().info("creating marketplace order for", { offerId, userId: user.id });

	const offer = await offerDb.Offer.get(offerId); // cached
	if (!offer) {
		throw NoSuchOffer(offerId);
	}

	const appOffers = await AppOffer.getAppOffers(user.appId, offer.type); // cached
	const appOffer = appOffers.find(app_offer => app_offer.offerId === offerId);
	if (!appOffer) {
		throw NoSuchOffer(offerId);
	}

	const order = await lock(getLockResource("get", offerId, user.id), async () =>
		(await db.Order.getOpenOrder(offerId, user.id)) ||
		(await lock(getLockResource("create", offerId), () => createOrder(appOffer, user, userDeviceId, orderTranslations)))
	);

	if (!order) {
		throw OfferCapReached(offerId);
	}

	logger().info("created new open marketplace order", order);

	return openOrderDbToApi(order, user.id);
}

async function createP2PExternalOrder(sender: User, senderDeviceId: string, jwt: ExternalPayToUserOrderJWT): Promise<db.ExternalOrder> {
	const senderWallet = (await sender.getWallets(senderDeviceId)).lastUsed();
	if (!senderWallet) {
		throw UserHasNoWallet(sender.id, senderDeviceId);
	}

	const recipient = await User.findOne({ appId: sender.appId, appUserId: jwt.recipient.user_id });
	if (!recipient) {
		throw NoSuchUser(jwt.recipient.user_id);
	}

	const recipientWallet = (await recipient.getWallets()).lastUsed();
	if (!recipientWallet) {
		throw UserHasNoWallet(recipient.id);
	}

	// check wallet version matches
	if (await WalletApplication.getBlockchainVersion(senderWallet.address) !==
		await WalletApplication.getBlockchainVersion(recipientWallet.address)) {
		logger().warn("failed p2p creation due to blockchain version mismatch");
		throw UserHasNoWallet(recipient.id);
	}

	const order = db.ExternalOrder.new({
		offerId: jwt.offer.id,
		amount: jwt.offer.amount,
		status: "opened",
		nonce: jwt.nonce,
		blockchainData: {
			sender_address: senderWallet.address,
			recipient_address: recipientWallet.address
		}
	}, {
		type: "earn",
		user: recipient,
		wallet: recipientWallet.address,
		meta: pick(jwt.recipient, "title", "description")
	}, {
		user: sender,
		type: "spend",
		wallet: senderWallet.address,
		meta: pick(jwt.sender, "title", "description")
	});

	await addWatcherEndpoint(recipientWallet.address, order.id, sender.appId);
	return order;
}

async function createNormalEarnExternalOrder(recipient: User, recipientDeviceId: string, jwt: ExternalEarnOrderJWT) {
	const app = (await Application.get(recipient.appId))!;
	if (!app) {
		throw NoSuchApp(recipient.appId);
	}

	const wallet = (await recipient.getWallets(recipientDeviceId)).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(recipient.id, recipientDeviceId);
	}

	return db.ExternalOrder.new({
		offerId: jwt.offer.id,
		amount: jwt.offer.amount,
		nonce: jwt.nonce,
		status: "opened",
		blockchainData: {
			sender_address: app.walletAddresses.sender,
			recipient_address: wallet.address
		}
	}, {
		type: "earn",
		user: recipient,
		wallet: wallet.address,
		meta: pick(jwt.recipient, "title", "description")
	});
}

async function createNormalSpendExternalOrder(sender: User, senderDeviceId: string, jwt: ExternalSpendOrderJWT) {
	const app = (await Application.all()).get(sender.appId);

	if (!app) {
		throw NoSuchApp(sender.appId);
	}

	const wallet = (await sender.getWallets(senderDeviceId)).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(sender.id, senderDeviceId);
	}

	const order = db.ExternalOrder.new({
		offerId: jwt.offer.id,
		amount: jwt.offer.amount,
		status: "opened",
		nonce: jwt.nonce,
		blockchainData: {
			sender_address: wallet.address,
			recipient_address: app.walletAddresses.recipient
		}
	}, {
		user: sender,
		type: "spend",
		wallet: wallet.address,
		meta: pick(jwt.sender, "title", "description")
	});

	await addWatcherEndpoint(app.walletAddresses.recipient, order.id, app.id);

	return order;
}

export async function createExternalOrder(jwt: string, user: User, userDeviceId: string): Promise<OpenOrder> {
	logger().info("createExternalOrder", { jwt });
	const payload = await validateExternalOrderJWT(jwt, user, userDeviceId);
	const nonce = payload.nonce || db.Order.DEFAULT_NONCE;

	let order = await db.Order.getOne({ offerId: payload.offer.id, userId: user.id, nonce });

	if (!order || order.status === "failed") {
		if (isPayToUser(payload)) {
			order = await createP2PExternalOrder(user, userDeviceId, payload);
		} else if (isExternalEarn(payload)) {
			order = await createNormalEarnExternalOrder(user, userDeviceId, payload);
		} else {
			order = await createNormalSpendExternalOrder(user, userDeviceId, payload);
		}

		await order.save();

		metrics.createOrder("external", order.flowType(), user.appId);

		logger().info("created new open external order", {
			offerId: payload.offer.id,
			userId: user.id,
			orderId: order.id
		});
	} else if (order.status === "pending" || order.status === "completed") {
		logger().info(
			`order cant be created. existing order ${ order.id } for offer ${ order.offerId } is ${ order.status }`
			,
			{ order });
		throw ExternalOrderAlreadyCompleted(order.id, order.status);
	}

	return openOrderDbToApi(order, user.id);
}

export async function submitOrder(
	orderId: string,
	user: User,
	userDeviceId: string,
	form: string | undefined,
	transaction?: string | undefined): Promise<Order> {
	const order = await db.Order.getOne({ orderId });

	if (!order || order.contextForUser(user.id) === null) {
		throw NoSuchOrder(orderId);
	}
	const context = order.contextForUser(user.id)!;
	const walletAddress = context.wallet;

	if (order.status !== "opened") {
		return orderDbToApi(order, user.id, walletAddress);
	}
	if (order.isExpired()) {
		throw OpenOrderExpired(orderId);
	}
	if (order.isMarketplaceOrder()) {
		await submitFormAndMutateMarketplaceOrder(order, form);
	}

	const app = (await Application.get(context.user.appId))!;
	const blockchainVersion = app.config.blockchain_version === "3" ? "3" : await WalletApplication.getBlockchainVersion(walletAddress);

	if (order.isEarn()) {
		// must be after submit form because order.amount changes
		await assertRateLimitEarn(user, walletAddress, order.amount);
	} else {
		if (blockchainVersion === "3") {
			if (!transaction) {
				throw MissingField("transaction");
			}
		}
	}

	order.setStatus("pending");
	await order.save();
	logger().info("order changed to pending", { orderId });

	if (order.isEarn()) {
		await payment.payTo(order.blockchainData.recipient_address!, user.appId, order.amount, order.id, blockchainVersion);
		createEarnTransactionBroadcastToBlockchainSubmitted(user.id, userDeviceId, order.offerId, order.id).report();
	} else {
		if (transaction) { // there is only transaction on kin3
			await payment.submitTransaction(order.blockchainData.recipient_address!, order.blockchainData.sender_address!, user.appId, order.amount, order.id, transaction!);
			createSpendTransactionBroadcastToBlockchainSubmitted(user.id, userDeviceId, order.offerId, order.id).report();
		}
	}

	metrics.submitOrder(order.origin, order.flowType(), user.appId, blockchainVersion);
	return await orderDbToApi(order, user.id, walletAddress);
}

export async function cancelOrder(orderId: string, userId: string): Promise<void> {
	// you can only delete an open order - not a pending order
	const order = await db.Order.getOne({ orderId, status: "opened" });
	if (!order || order.contextForUser(userId) === null) {
		throw NoSuchOrder(orderId);
	}

	try {
		await order.remove();
	} catch (e) {
		// don't care about failures
	}
}

export async function getOrderHistory(
	user: User,
	deviceId: string,
	filters: { origin?: db.OrderOrigin; offerId?: string; },
	limit: number = 25,
	before?: string,
	after?: string): Promise<OrderList> {

	// XXX use the cursor input values
	const status: db.OrderStatusAndNegation = "!opened";
	const wallet = (await user.getWallets(deviceId)).lastUsed();
	if (!wallet) {
		throw UserHasNoWallet(user.id, deviceId);
	}

	const orders = await db.Order.getAll({
		...filters,
		status,
		walletAddress: wallet.address
	}, limit);

	return {
		orders: await Promise.all(orders.map(async order => {
			checkIfTimedOut(order); // no need to wait for the promise
			return await orderDbToApi(order, user.id, wallet.address);
		})),
		paging: {
			cursors: {
				after: "MTAxNTExOTQ1MjAwNzI5NDE",
				before: "NDMyNzQyODI3OTQw",
			},
			previous: "https://api.kinmarketplace.com/v2/orders?limit=25&before=NDMyNzQyODI3OTQw",
			next: "https://api.kinmarketplace.com/v2/orders?limit=25&after=MTAxNTExOTQ1MjAwNzI5NDE=",
		},
	};
}

function openOrderDbToApi(order: db.Order, userId: string): OpenOrder {
	if (order.status !== "opened") {
		throw OpenedOrdersOnly();
	}

	const context = order.contextForUser(userId)!;
	return {
		id: order.id,
		nonce: order.nonce,
		offer_id: order.offerId,
		offer_type: context.type,
		amount: order.amount,
		title: context.meta.title,
		description: context.meta.description,
		blockchain_data: order.blockchainData,
		expiration_date: order.expirationDate!.toISOString()
	};
}

async function orderDbToApi(order: db.Order, userId: string, wallet: string): Promise<Order> {
	if (order.status === "opened") {
		throw OpenedOrdersUnreturnable();
	}

	const apiOrder = Object.assign(
		pick(order, "id", "origin", "status", "amount"), {
			result: order.value,
			offer_id: order.offerId,
			error: order.error as ApiError,
			blockchain_data: order.blockchainData,
			completion_date: (order.currentStatusDate || order.createdDate).toISOString()
		}) as Order;

	const data: any = {};
	let context = order.contextForUser(userId)!;
	if (context) {
		Object.assign(data, {
			offer_type: context.type,
		}, pick(context.meta, "title", "description", "content", "call_to_action"));
	} else {
		context = order.contextForWallet(wallet)!;
		const app = (await Application.all()).get(context.user.appId)!;

		Object.assign(data, {
			offer_type: context.type,
		}, pick(context.meta, "title", "description", "content", "call_to_action"));

		data.title = app.name;
		if (order.isMarketplaceOrder()) {
			const offerContent = (await offerDb.OfferContent.get(order.offerId))!;
			data.description = offerContent && offerContent.contentType ? capitalizeFirstLetter(offerContent.contentType) : "Completed";
		} else {
			data.description = "Completed";
		}
	}

	return Object.assign({}, apiOrder, data);
}

export async function setFailedOrder(order: db.Order, error: MarketplaceError, failureDate?: Date): Promise<void> {
	try {
		order.setStatus("failed");
		order.currentStatusDate = failureDate || order.currentStatusDate;
		order.error = error.toJson();

		metrics.orderFailed(order);
		await order.save();
	} catch (e) {
		// this function isn't awaited - so catch all here to not create promise rejection
		logger().error("setFailedOrder caught error", { e, orderId: order.id });
	}
}

function checkIfTimedOut(order: db.Order): Promise<void> {
	// TODO This should be done in a cron that runs every 10 minutes and closes these orders
	if (order.status === "pending" && order.isExpired()) {
		return setFailedOrder(order, TransactionTimeout(), order.expirationDate) as any;
	}

	return Promise.resolve();
}

function getLockResource(type: "create" | "get", ...ids: string[]): string {
	return `locks:orders:${ type }:${ ids.join(":") }`;
}

export async function createOutgoingTransferOrder(recipientWalletAddress: string, recipientAppId: string, title: string, description: string, memo: string, amount: number, sender: User, senderDeviceId: string): Promise<OpenOrder> {
	logger().info("creating an outgoing transfer order");
	const senderWallet = (await sender.getWallets(senderDeviceId)).lastUsed();
	if (!senderWallet) {
		throw UserHasNoWallet(sender.id, senderDeviceId);
	}

	const order = db.OutgoingTransferOrder.new({
		offerId: `cross-app_${sender.appId}_to_${recipientAppId}`,
		amount,
		status: "opened",
		blockchainData: {
			sender_address: senderWallet.address,
			recipient_address: recipientWalletAddress,
			memo
		}
	}, {
		user: sender,
		type: "spend",
		wallet: senderWallet.address,
		meta: { title, description }
	});

	await order.save();

	logger().info("created an outgoing transfer order");

	return openOrderDbToApi(order, sender.id);
}

export async function createIncomingTransferOrder(title: string, description: string, memo: string, senderWalletAddress: string, appId: string, receiver: User, receiverDeviceId: string): Promise<Order> {
	logger().info("creating an incoming transfer order");
	const receiverWallet = (await receiver.getWallets(receiverDeviceId)).lastUsed();
	if (!receiverWallet) {
		throw UserHasNoWallet(receiver.id, receiverDeviceId);
	}

	const order = db.IncomingTransferOrder.new({
		offerId: `cross-app_${appId}_to_${receiver.appId}`,
		status: "pending",
		amount: 0, // not allowed to insert an order without amount
		blockchainData: {
			sender_address: senderWalletAddress,
			recipient_address: receiverWallet.address,
			memo
		}
	}, {
		user: receiver,
		type: "earn",
		wallet: receiverWallet.address,
		meta: { title, description }
	});

	await order.save();

	// we create a redis entry so this memo can uniquely identify this order.id down the line
	// i.e. when the watch we gonna add triggers a callback
	const parsedMemo = parseMemo(memo);
	const redis = getRedisClient();
	await redis.async.set(transferKey(parsedMemo.orderId), order.id);

	// adding a watch
	await addWatcherEndpoint(receiverWallet.address, parsedMemo.orderId, receiver.appId);

	logger().info("created an incoming transfer order", { title, description, memo, senderWalletAddress, appId });

	return orderDbToApi(order, receiver.id, receiverWallet.address);
}
