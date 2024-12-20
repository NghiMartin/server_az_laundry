const asyncHandle = require('express-async-handler');
const crypto = require("crypto");
const moment = require('moment');
const PaymentModel = require('../models/payment_model');
const CartModel = require('../models/cart_model');
const querystring = require('qs');
const { default: mongoose } = require('mongoose');
const UserModel = require('../models/user_model');
require('dotenv').config();

function sortObject(obj) {
    let sorted = {};
    let str = [];
    let key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) {
            str.push(encodeURIComponent(key));
        }
    }
    str.sort();
    for (key = 0; key < str.length; key++) {
        sorted[str[key]] = encodeURIComponent(obj[str[key]]).replace(/%20/g, "+");
    }
    return sorted;
}

const createPayment = asyncHandle(async (req, res) => {
    const { id_user, paymentMethod, data_payment , id_product, full_name,number_phone,address,shop_details} = req.body;
    const { shipping_fee, discount, taxes, total, shipping_date, delivery_date,product_condition,shipping_mode,note } = data_payment;
    console.log(shipping_date)
    let id_cart = null;
    const carts = await CartModel.find({ id_user: id_user,status:'Pending' }).populate('id_product');
    if (carts.length === 0) {
        return res.status(200).json({ message: "Không tìm thấy giỏ hàng, không thể thanh toán" });
    }
    if (!id_product) {
        id_cart = carts.map(cart => cart._id);
    }
    
    const amount_money = total + (shipping_fee || 0) - (discount || 0) + (taxes || 0);
    const formattedShopDetails = shop_details.map(detail => ({
        id_shop: new mongoose.Types.ObjectId(detail.id_shop), // Chuyển id_shop thành ObjectId
        service_fee: detail.cart_subtotal_shop, // Sử dụng cart_subtotal_shop làm service_fee
        shipping_fee: detail.shipping_fee_shop // Gán shipping_fee_shop
    }));
    const payment = new PaymentModel({
        id_user,
        id_cart: id_cart,
        mount_money: amount_money,
        id_product:id_product||null,
        method_payment:paymentMethod,
        full_name,
        number_phone,
        address,
        status: 'Pending',
        data_payment: {
            shipping_fee: shipping_fee || 0,
            discount: discount || 0,
            taxes: taxes || 0,
            total: total,
            shipping_date: shipping_date,
            delivery_date: delivery_date,
            product_condition:product_condition,
            shipping_mode:shipping_mode,
            note:note
        },
        shop_details: formattedShopDetails, 
    });

    try {
        await payment.save()
        const findIdUser = await PaymentModel.findById(payment._id).populate('id_user')
        if (paymentMethod === 'VNPay') {
            let ipAddr = req.headers['x-forwarded-for'] ||
                req.connection.remoteAddress ||
                req.socket.remoteAddress ||
                req.connection.socket.remoteAddress;
            
            const vnpUrl = "https://sandbox.vnpayment.vn/paymentv2/vpcpay.html";
            const vnp_TmnCode = "9KDMIQHJ";
            const vnp_HashSecret = process.env.vnp_HashSecret;
            const vnp_ReturnUrl = `${process.env.IP_Address}/api/payment/vnpay_return`;
            const orderId = payment._id.toString();
            const createDate = moment().format('YYYYMMDDHHmmss');
            const vnp_Params = {
                vnp_Version: "2.1.0",
                vnp_Command: "pay",
                vnp_TmnCode,
                vnp_Amount: amount_money * 100,
                vnp_CurrCode: "VND",
                vnp_TxnRef: orderId,
                vnp_OrderInfo: `Thanh toán hóa đơn ${orderId}`,
                vnp_OrderType: "billpayment",
                vnp_Locale: "vn",
                vnp_ReturnUrl,
                vnp_IpAddr: ipAddr,
                vnp_CreateDate: createDate
            };

            let sortedParams = sortObject(vnp_Params);
            let signData = querystring.stringify(sortedParams, { encode: false });
            let hmac = crypto.createHmac("sha512", vnp_HashSecret);
            let signed = hmac.update(Buffer.from(signData, 'utf-8')).digest("hex");
            sortedParams['vnp_SecureHash'] = signed;
            const paymentUrl = `${vnpUrl}?${querystring.stringify(sortedParams, { encode: false })}`;
            return res.status(200).json({ success: true, paymentUrl, orderId });
        } else {
            if(findIdUser.status==="Pending"){
                await PaymentModel.findByIdAndUpdate(payment._id, { status: "COD" });
                const carts = await CartModel.updateMany(
                    { id_user: findIdUser.id_user._id, status: "Pending" },
                    { $set: { status: "COD" } }
                );
                if(carts){
                    return res.status(200).json({ data: payment, message: "Thanh toán thành công" });
                }
            }
            return res.status(500).json({ success: false, message: "fail" });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
});

const handleVNPayReturn = asyncHandle(async (req, res) => {
    const vnp_Params = req.query;
    const secureHash = vnp_Params.vnp_SecureHash;
    delete vnp_Params.vnp_SecureHash;
    delete vnp_Params.vnp_SecureHashType;
    const vnp_HashSecret = process.env.vnp_HashSecret;
    let sortedParams = sortObject(vnp_Params);
    let signData = querystring.stringify(sortedParams, { encode: false });
    let hmac = crypto.createHmac("sha512", vnp_HashSecret);
    let signed = hmac.update(Buffer.from(signData, 'utf-8')).digest("hex");
    if (secureHash === signed) {
        const orderId = vnp_Params.vnp_TxnRef;
        const paymentStatus = vnp_Params.vnp_ResponseCode === "00" ? "Paid" : "Failed";
        console.log('status',paymentStatus);
        
        await PaymentModel.findByIdAndUpdate(orderId, { status: paymentStatus });
        const findIdUser = await PaymentModel.findById(orderId).populate('id_user')
        if (findIdUser.status === "Paid") {
            const carts = await CartModel.updateMany(
                { id_user: findIdUser.id_user._id, status: "Pending" },
                { $set: { status: "Paid" } }
            );
            if (carts && findIdUser.status === 'Paid') {
                return res.status(200).json({ success: true, message: "Thanh toán thành công" });
            }
        }
        return res.status(200).json({ success: true, message: "Tới trang thanh toán thành công" });
    } else {
        return res.status(400).json({ success: false, message: "Xác thực thất bại" });
    }
});

const getOrder = asyncHandle(async (req, res) => {
    try {
        const { userId } = req.query; // Nhận userId từ query params

        const orders = await PaymentModel.find({ status: { $in: ["Paid", "COD"] } })
            .sort({ createdAt: -1 })
            .populate('id_user')
            .populate({
                path: 'id_cart',
                populate: {
                    path: 'id_product',
                    match: { id_user: userId },
                },
            });

        res.status(200).json({
            message: "Lấy đơn hàng thành công",
            data: orders,
        });
    } catch (error) {
        res.status(400).send(error);
    }
});

const getOrderByIdShop = asyncHandle(async (req, res) => {
    try {
        const { userId } = req.query;

        // Tìm đơn hàng với status là "Paid" hoặc "COD"
        const orders = await PaymentModel.find({
            status: { $in: ["Paid", "COD"] }
        })
            .sort({ createdAt: -1 })
            .populate('id_user')
            .populate({
                path: 'id_cart',
                populate: {
                    path: 'id_product',
                },
            });

        // Lọc đơn hàng dựa trên userId trong id_cart
        const filteredOrders = orders.map(order => {
            // Lọc shop_details chỉ chứa id_shop khớp với userId
            const filteredShopDetails = order.shop_details.filter(shopDetail =>
                shopDetail.id_shop.toString() === userId
            );

            // Tạo bản sao của đơn hàng với shop_details đã lọc
            return {
                ...order.toObject(),
                shop_details: filteredShopDetails
            };
        }).filter(order => order.shop_details.length > 0); // Loại bỏ các đơn hàng không có shop_details khớp

        res.status(200).json({
            message: "Lấy đơn hàng thành công",
            data: filteredOrders,
        });
    } catch (error) {
        res.status(400).json({
            message: "Lỗi khi lấy đơn hàng",
            error: error.message,
        });
    }
});


const getOrderById = asyncHandle(async (req, res) => {
    try {
        const { _id } = req.params;
        const order = await PaymentModel.findOne({ _id })
            .sort({ createdAt: -1 })
            .populate('id_user')
            .populate({
                path: 'id_cart',
                populate: {
                    path: 'id_product',
                },
            });
        res.status(200).json({
            message: "Lấy thông tin đơn hàng thành công",
            data: order,
        });
    } catch (error) {
        res.status(500).json({
            message: "Có lỗi xảy ra khi lấy thông tin đơn hàng",
            error: error.message,
        });
    }
});

const getOrderByIdUser = asyncHandle(async (req, res) => {
    try {
        const { id_user } = req.params;
        const order = await PaymentModel.find({
            id_user,
            status: { $in: ["Paid", "COD"] } // Lọc status là "Paid" hoặc "COD"
        })
            .sort({ createdAt: -1 })
            .populate({
                path: 'id_cart',
                populate: {
                    path: 'id_product',
                },
            });
        res.status(200).json({
            message: "Lấy danh sách đơn hàng thành công",
            data: order,
        });
    } catch (error) {
        res.status(500).json({
            message: "Có lỗi xảy ra khi lấy thông tin đơn hàng",
            error: error.message,
        });
    }
});

const updateConfirmationStatus = asyncHandle(async (req, res) => {
    const { _id, id_shop, confirmationStatus } = req.body;
    if (!_id || !id_shop || !confirmationStatus) {
        return res.status(400).json({
            message: "id, id_shop, and confirmationStatus are required",
        });
    }
    try {
        // Kiểm tra xem id_shop có tồn tại trong shop_details
        const payment = await PaymentModel.findOne({
            _id,
            "shop_details.id_shop": id_shop,
        });

        if (!payment) {
            return res.status(404).json({
                message: "Không tìm thấy id_shop",
            });
        }
        // Kiểm tra nếu status là 'Paid' thì không cho phép cập nhật thành 'Đã hủy'
        if (payment.status === "Paid" && confirmationStatus === "Đã hủy") {
            return res.status(400).json({
                message: "Không thể hủy vì đã thanh toán VNPay",
            });
        }
        // Cập nhật confirmationStatus cho shop_details với id_shop khớp
        const updatedPayment = await PaymentModel.findOneAndUpdate(
            { _id, "shop_details.id_shop": id_shop },
            {
                $set: {
                    "shop_details.$.confirmationStatus": confirmationStatus,
                },
            },
            { new: true, runValidators: true }
        );
        if (!updatedPayment) {
            return res.status(404).json({
                message: "cập nhật không thành công",
            });
        }
        if (confirmationStatus === "Hoàn thành") {
            await UserModel.findByIdAndUpdate(
                id_shop, 
                { $inc: { "data_user.order_count": 1 } },
                { new: true }
            );
        }
        res.status(200).json({
            message: "Cập nhật thành công",
            data: updatedPayment,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Error",
            error: error.message,
        });
    }
});

const getOrdersByStatus = asyncHandle(async (req, res) => {
    try {
        const { status, userId } = req.query; // Lấy trạng thái và userId từ query string

        // Tạo bộ lọc confirmationStatus nếu có
        const filter = status ? { "shop_details.confirmationStatus": status } : {};

        // Lấy tất cả các đơn hàng thỏa mãn bộ lọc
        const orders = await PaymentModel.find(filter)
            .sort({ createdAt: -1 })
            .populate('id_user')
            .populate({
                path: 'id_cart',
                populate: {
                    path: 'id_product',
                },
            });

        // Lọc các đơn hàng dựa trên userId trong id_shop
        const filteredOrders = orders.map(order => {
            // Lọc mảng shop_details dựa trên id_shop
            const filteredShopDetails = order.shop_details.filter(shopDetail =>
                shopDetail.id_shop.toString() === userId &&
                (!status || shopDetail.confirmationStatus === status) // Lọc thêm theo status nếu có
            );

            // Trả lại đơn hàng chỉ với shop_details đã lọc
            return {
                ...order.toObject(),
                shop_details: filteredShopDetails
            };
        }).filter(order => order.shop_details.length > 0); // Loại bỏ đơn hàng không có shop_details phù hợp

        res.status(200).json({
            message: "Lấy danh sách đơn hàng thành công",
            data: filteredOrders,
        });
    } catch (error) {
        res.status(500).json({
            message: "Có lỗi xảy ra khi lấy danh sách đơn hàng",
            error: error.message,
        });
    }
});



module.exports = { createPayment, handleVNPayReturn, getOrder, getOrderById, updateConfirmationStatus, getOrdersByStatus, getOrderByIdUser, getOrderByIdShop };
